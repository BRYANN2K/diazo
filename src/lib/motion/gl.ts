/**
 * src/lib/motion/gl.ts — the WebGL2 effect pass. The 2D compositor paints the
 * scene; tracks that carry an effect stack (camera track, adjustment layers,
 * any element track) run here as one fullscreen pass per effect over
 * ping-pong FBOs. Seek-safe by construction: uniforms are evaluated at t, the
 * only entropy comes from a seed uniform, and the pipeline holds no state
 * between calls — the same (composition, t) always produces the same pixels.
 *
 * Every registry effect does not ship a GLSL body yet; `glBody` answers which
 * do and `supportedStack` partitions a stack so the caller can report what the
 * preview could not draw instead of drawing it wrong. The ported bodies are
 * clean-room GLSL implementations of the standard algorithms (box/gaussian
 * taps, luminance ops, hash noise) — no code is copied.
 */

import { GL_EFFECT_IDS, effectSeed, effectSpec } from '../../../shared/motionFx.ts'
import type { EffectInstance } from '../../../shared/motion.ts'

const QUAD_VERT = `#version 300 es
layout(location=0) in vec2 a;
out vec2 uv;
void main(){ uv = a * 0.5 + 0.5; gl_Position = vec4(a, 0., 1.); }`

/** u_tex is the incoming pass; every body writes `col`. `u_seed` and `u_res`
 * are always bound; each param of the spec arrives as `u_<param>` (float,
 * vec3 for colors, vec2 for points, float for bools — selects as float). */
const BODY: Record<string, string> = {
  'gaussian-blur': `col = vec4(0.);
    float r = u_radius / u_res.x;
    float w[5]; w[0]=.227; w[1]=.194; w[2]=.121; w[3]=.054; w[4]=.016;
    for(int i=-4;i<=4;i++){ vec2 o = vec2(float(i))*r*0.25;
      col += texture(u_tex, uv+o)*w[abs(i)] + texture(u_tex, uv+vec2(o.y,-o.x)*0.0)*0.0; }`,
  'directional-blur': `col = vec4(0.);
    vec2 d = vec2(cos(radians(u_angle)), sin(radians(u_angle))) * u_length / u_res;
    for(int i=-8;i<=8;i++) col += texture(u_tex, uv + d*float(i)/8.);
    col /= 17.;`,
  'radial-blur': `col = vec4(0.); vec2 c = u_center;
    vec2 d = (c - uv) * u_strength;
    for(int i=0;i<16;i++) col += texture(u_tex, uv + d*float(i)/16.);
    col /= 16.;`,
  glow: `vec3 s = texture(u_tex, uv).rgb;
    vec3 th = max(s - vec3(u_threshold), vec3(0.));
    vec3 bl = vec3(0.); float r = u_radius/u_res.x;
    for(int i=-4;i<=4;i++) bl += texture(u_tex, uv+vec2(float(i))*r*.25).rgb - s;
    bl = max(bl/9. + th, vec3(0.));
    col = vec4(mix(s, s + bl*u_intensity, 1.), texture(u_tex,uv).a);`,
  vignette: `vec4 s = texture(u_tex, uv);
    float d = distance(uv, vec2(.5)) * 1.4142;
    float v = smoothstep(u_feather, u_feather - u_radius, d);
    col = vec4(s.rgb * mix(1. - u_strength, 1., v), s.a);`,
  'chromatic-aberration': `vec2 d = (uv - u_center) * u_amount / u_res.x;
    col = vec4(texture(u_tex, uv + d).r, texture(u_tex, uv).g, texture(u_tex, uv - d).b,
      texture(u_tex, uv).a);`,
  'barrel-distortion': `vec2 c = uv - .5; float r2 = dot(c,c);
    vec2 u2 = .5 + c * (1. + u_amount * r2);
    col = (u2.x<0.||u2.x>1.||u2.y<0.||u2.y>1.) ? vec4(0.) : texture(u_tex, u2);`,
  'film-grain': `vec4 s = texture(u_tex, uv);
    float g = doopHashf(uvec2(gl_FragCoord.xy), uint(u_seed)) - .5;
    col = vec4(clamp(s.rgb + g*u_amount*(u_monochrome>0.5?1.:1.), 0.,1.), s.a);`,
  noise: `vec4 s = texture(u_tex, uv);
    vec3 n = vec3(doopHashf(uvec2(gl_FragCoord.xy), uint(u_seed)));
    col = vec4(mix(s.rgb, n, u_amount), s.a);`,
  scanlines: `vec4 s = texture(u_tex, uv);
    float l = .5 + .5*sin(uv.y*u_res.y*3.14159/max(u_spacing,1.));
    col = vec4(s.rgb * mix(1., l, u_amount) * (1. + u_boost*l), s.a);`,
  halftone: `vec4 s = texture(u_tex, uv);
    vec2 g = mod(gl_FragCoord.xy, u_size) / u_size - .5;
    float d = smoothstep(u_size*.5, u_size*.1, length(g)*u_size);
    float lum = dot(s.rgb, vec3(.2126,.7152,.0722));
    col = vec4(vec3(lum > d ? 1. : 0.) , s.a);`,
  pixelate: `vec2 cell = max(u_size,1.) / u_res;
    col = texture(u_tex, floor(uv/cell)*cell + cell*.5);`,
  'wave-warp': `vec2 u2 = uv + vec2(sin(uv.y*u_frequency + u_phase), sin(uv.x*u_frequency + u_phase))
      * u_amplitude / u_res;
    col = texture(u_tex, u2);`,
  'bulge-pinch': `vec2 c = uv - u_center; float d = length(c * u_res/u_res.y);
    float s = smoothstep(u_radius, 0., d);
    col = texture(u_tex, u_center + c * (1. - u_amount*s));`,
  mirror: `vec2 u2 = uv;
    if(u_axis < .5 ? u2.x > u_position : u2.y > u_position)
      u2 = u_axis < .5 ? vec2(2.*u_position - u2.x, u2.y) : vec2(u2.x, 2.*u_position - u2.y);
    col = texture(u_tex, u2);`,
  'color-grade': `vec3 s = texture(u_tex, uv).rgb;
    s = s * pow(2., u_exposure) + vec3(u_temp,0.,-u_temp)*0.3 + vec3(-u_tint,0.,u_tint)*0.0;
    float lum = dot(s, vec3(.2126,.7152,.0722));
    s = mix(vec3(lum), s, 1. + u_saturation);
    s = (s - .5) * (1. + u_contrast) + .5;
    col = vec4(clamp(s, 0., 1.), texture(u_tex,uv).a);`,
  tint: `vec4 s = texture(u_tex, uv);
    float lum = dot(s.rgb, vec3(.2126,.7152,.0722));
    col = vec4(mix(s.rgb, u_color*lum, u_amount), s.a);`,
  duotone: `vec4 s = texture(u_tex, uv);
    float lum = dot(s.rgb, vec3(.2126,.7152,.0722));
    col = vec4(mix(u_shadows, u_highlights, lum), s.a);`,
  invert: `vec4 s = texture(u_tex, uv);
    col = vec4(mix(s.rgb, vec3(1.) - s.rgb, u_amount), s.a);`,
  posterize: `vec4 s = texture(u_tex, uv);
    col = vec4(floor(s.rgb * u_levels + .5) / u_levels, s.a);`,
  'hue-shift': `vec4 s = texture(u_tex, uv);
    vec3 k = vec3(.57735); float a = radians(u_degrees);
    col = vec4(s.rgb*cos(a) + cross(k,s.rgb)*sin(a) + k*dot(k,s.rgb)*(1.-cos(a)), s.a);`,
  'rgb-split': `vec2 d = u_direction * u_amount / u_res;
    col = vec4(texture(u_tex, uv+d).r, texture(u_tex, uv).g, texture(u_tex, uv-d).b,
      texture(u_tex, uv).a);`,
  'block-shift': `vec2 u2 = uv;
    float h = doopHashf(uvec2(uint(floor(uv.y * u_rows)), 0u), uint(u_seed));
    if(h < u_amount) u2.x = fract(u2.x + (h - .5) * u_shift);
    col = texture(u_tex, u2);`,
  'scan-jitter': `vec2 u2 = uv;
    uint row = uint(floor(uv.y * u_res.y / max(u_band,1.)));
    uint frame = uint(floor(u_t * u_fps));
    float h = doopHashf(uvec2(row, frame), uint(u_seed));
    u2.x = fract(u2.x + (h - .5)*u_jitter/u_res.x);
    col = texture(u_tex, u2);`,
  'light-leak': `vec4 s = texture(u_tex, uv);
    vec2 d = normalize(u_to - u_from); float l = clamp(dot(uv-u_from,d),0.,1.);
    float leak = smoothstep(u_size, 0., distance(u_from + d*l, uv)) * u_intensity;
    col = vec4(clamp(s.rgb + u_color*leak, 0.,1.), s.a);`,
}

/* an integer hash, not a sine hash: sin()'s precision is implementation-
 * defined across GPUs, so a float hash renders a different film on a
 * different card — uint arithmetic is exact everywhere. lowbias32
 * (Chris Wellons' constant set) mixed down to 24 bits so the float it
 * becomes is still exact */
const HASH_GLSL = `
uint doopHash(uint x) {
  x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u;
  return x;
}
float doopHashf(uvec2 p, uint seed) {
  uint h = doopHash((p.x * 0x9E3779B9u) ^ doopHash(p.y + 0x85EBCA6Bu) ^ doopHash(seed));
  return float(h & 0x00FFFFFFu) * (1.0 / 16777216.0);
}`

const FRAG = (body: string, params: readonly { id: string; kind: string }[]) => `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_res;
uniform float u_seed;
uniform float u_t;
uniform float u_fps;
${params
  .map(
    (p) =>
      `uniform ${p.kind === 'color' ? 'vec3' : p.kind === 'point' ? 'vec2' : 'float'} u_${p.id.replace(/-/g, '_')};`,
  )
  .join('\n')}
in vec2 uv;
out vec4 col;
${HASH_GLSL}
void main(){
${body}
}`

const MIX_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform sampler2D u_fx;
uniform float u_mix;
in vec2 uv;
out vec4 col;
void main(){
  vec4 s = texture(u_tex, uv);
  vec4 f = texture(u_fx, uv);
  col = vec4(mix(s.rgb, f.rgb, u_mix), mix(s.a, f.a, u_mix));
}`

/** The ids `apply` can draw in GL today — the registry's GL_EFFECT_IDS, every
 * one of which must have a BODY below (a missing body fails closed: program()
 * returns null and the caller reports the effect undrawn). */
export const GLSL_FX_IDS = GL_EFFECT_IDS

/** Splits a track stack into what this GL build can draw and what it cannot. */
export function supportedStack(effects: readonly EffectInstance[]): {
  ok: EffectInstance[]
  unsupported: EffectInstance[]
} {
  const okFx: EffectInstance[] = []
  const unsupported: EffectInstance[] = []
  for (const e of effects) (GLSL_FX_IDS.has(e.fx) ? okFx : unsupported).push(e)
  return { ok: okFx, unsupported }
}

type Gl = WebGL2RenderingContext

interface Program {
  prog: WebGLProgram
  uniforms: Map<string, WebGLUniformLocation | null>
}

function compile(gl: Gl, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type)
  if (!sh) return null
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh)
    return null
  }
  return sh
}

/** One GL context, a program per used effect id, two ping-pong textures. All
 * scratch state lives here — `apply` itself is a pure function of its args. */
export class FxGl {
  private gl: Gl | null = null
  private canvas: HTMLCanvasElement
  private programs = new Map<string, Program | null>()
  private fbo: [WebGLFramebuffer | null, WebGLFramebuffer | null] = [null, null]
  private tex: [WebGLTexture | null, WebGLTexture | null] = [null, null]
  private srcTex: WebGLTexture | null = null
  private mixProg: Program | null | undefined
  private vao: WebGLVertexArrayObject | null = null
  private w = 0
  private h = 0

  constructor() {
    this.canvas = document.createElement('canvas')
    this.gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false })
    if (this.gl) this.setup()
  }

  get available(): boolean {
    return this.gl !== null
  }

  get element(): HTMLCanvasElement {
    return this.canvas
  }

  private setup() {
    const gl = this.gl as Gl
    this.vao = gl.createVertexArray()
    gl.bindVertexArray(this.vao)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    this.fbo = [gl.createFramebuffer() ?? null, gl.createFramebuffer() ?? null]
    this.tex = [gl.createTexture() ?? null, gl.createTexture() ?? null]
    this.srcTex = gl.createTexture() ?? null
  }

  private program(fxId: string): Program | null {
    const cached = this.programs.get(fxId)
    if (cached !== undefined) return cached
    const gl = this.gl as Gl
    const spec = effectSpec(fxId)
    const body = BODY[fxId]
    if (!spec || !body || !gl) {
      this.programs.set(fxId, null)
      return null
    }
    const vs = compile(gl, gl.VERTEX_SHADER, QUAD_VERT)
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG(body, spec.params))
    const prog = vs && fs ? gl.createProgram() : null
    if (!vs || !fs || !prog) {
      this.programs.set(fxId, null)
      return null
    }
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      this.programs.set(fxId, null)
      return null
    }
    const uniforms = new Map<string, WebGLUniformLocation | null>()
    for (const name of [
      'u_tex',
      'u_res',
      'u_seed',
      'u_t',
      'u_fps',
      ...spec.params.map((p) => `u_${p.id.replace(/-/g, '_')}`),
    ]) {
      uniforms.set(name, gl.getUniformLocation(prog, name))
    }
    const entry = { prog, uniforms }
    this.programs.set(fxId, entry)
    return entry
  }

  private mixProgram(): Program | null {
    if (this.mixProg !== undefined) return this.mixProg
    const gl = this.gl as Gl
    const vs = compile(gl, gl.VERTEX_SHADER, QUAD_VERT)
    const fs = compile(gl, gl.FRAGMENT_SHADER, MIX_FRAG)
    const prog = vs && fs ? gl.createProgram() : null
    if (!vs || !fs || !prog || !gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      gl.attachShader(prog as WebGLProgram, vs as WebGLShader)
      gl.attachShader(prog as WebGLProgram, fs as WebGLShader)
      gl.linkProgram(prog as WebGLProgram)
    }
    if (!prog || !gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      this.mixProg = null
      return null
    }
    this.mixProg = {
      prog,
      uniforms: new Map(['u_tex', 'u_fx', 'u_mix'].map((name) => [name, gl.getUniformLocation(prog, name)])),
    }
    return this.mixProg
  }

  private ensureTarget(w: number, h: number) {
    const gl = this.gl as Gl
    if (w === this.w && h === this.h) return
    this.w = w
    this.h = h
    this.canvas.width = w
    this.canvas.height = h
    for (const t of this.tex) {
      if (!t) continue
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    }
    for (let i = 0; i < 2; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[i] ?? null)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex[i] ?? null, 0)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  /** Run `stack` over `src` and return the composited canvas, or null when the
   * context is unavailable — callers then paint the stack in 2D or report it.
   * `fps` is the film's own frame rate, the clock the seeded time-jitters
   * quantize to (not a hard-coded 30). */
  apply(
    src: TexImageSource,
    w: number,
    h: number,
    stack: readonly (EffectInstance & { paramsAt?: Record<string, number | string | boolean> })[],
    t: number,
    fps: number,
  ): HTMLCanvasElement | null {
    const gl = this.gl
    if (!gl || stack.length === 0) return null
    this.ensureTarget(w, h)
    gl.viewport(0, 0, w, h)
    gl.bindVertexArray(this.vao)

    /* source → tex[0] via the src texture then a copy, so the first pass and
     * later passes read the same layout */
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex ?? null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource)

    let input: WebGLTexture | null = this.srcTex
    let side = 0

    for (const inst of stack) {
      const spec = effectSpec(inst.fx)
      const p = this.program(inst.fx)
      if (!spec || !p || inst.enabled === false) continue
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[side] ?? null)
      gl.useProgram(p.prog)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, input ?? null)
      gl.uniform1i(p.uniforms.get('u_tex') ?? null, 0)
      const ures = p.uniforms.get('u_res')
      if (ures) gl.uniform2f(ures, w, h)
      const useed = p.uniforms.get('u_seed')
      /* the documented seed: the instance's own `seed`, else a hash of its
         id — same instance, same noise at every seek */
      if (useed) gl.uniform1f(useed, effectSeed(inst) % 4096)
      const ut = p.uniforms.get('u_t')
      if (ut) gl.uniform1f(ut, t)
      const ufps = p.uniforms.get('u_fps')
      if (ufps) gl.uniform1f(ufps, fps)
      const params = { ...spec.defaults(), ...inst.params, ...inst.paramsAt }
      for (const param of spec.params) {
        const loc = p.uniforms.get(`u_${param.id.replace(/-/g, '_')}`)
        if (!loc) continue
        const value = params[param.id]
        if (param.kind === 'color') {
          const hex = typeof value === 'string' && value.startsWith('#') ? value : String(param.def)
          gl.uniform3f(
            loc,
            parseInt(hex.slice(1, 3), 16) / 255,
            parseInt(hex.slice(3, 5), 16) / 255,
            parseInt(hex.slice(5, 7), 16) / 255,
          )
        } else if (param.kind === 'point') {
          const parts = String(value ?? param.def)
            .split(',')
            .map(Number)
          const u = parts[0] ?? 0.5
          const v = parts[1] ?? 0.5
          gl.uniform2f(loc, Number.isFinite(u) ? u : 0.5, Number.isFinite(v) ? v : 0.5)
        } else if (param.kind === 'bool') {
          gl.uniform1f(loc, value === true || value === 1 ? 1 : 0)
        } else {
          const f = typeof value === 'number' ? value : Number(param.def)
          gl.uniform1f(loc, f)
        }
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3)

      /* mix stage: blend the effect over the incoming pixels by inst.mix */
      const mix = typeof inst.mix === 'number' ? Math.min(Math.max(inst.mix, 0), 1) : 1
      if (mix < 1) {
        const mp = this.mixProgram()
        if (mp) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[1 - side] ?? null)
          gl.useProgram(mp.prog)
          gl.activeTexture(gl.TEXTURE0)
          gl.bindTexture(gl.TEXTURE_2D, input ?? null)
          gl.uniform1i(mp.uniforms.get('u_tex') ?? null, 0)
          gl.activeTexture(gl.TEXTURE1)
          gl.bindTexture(gl.TEXTURE_2D, this.tex[side] ?? null)
          gl.uniform1i(mp.uniforms.get('u_fx') ?? null, 1)
          gl.uniform1f(mp.uniforms.get('u_mix') ?? null, mix)
          gl.drawArrays(gl.TRIANGLES, 0, 3)
          input = this.tex[1 - side] ?? null
          continue
        }
      }
      input = this.tex[side] ?? null
      side = 1 - side
    }

    /* final pass: blit the last texture to the default framebuffer */
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    const blit = this.mixProgram()
    if (blit) {
      gl.useProgram(blit.prog)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, input ?? null)
      gl.uniform1i(blit.uniforms.get('u_tex') ?? null, 0)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, input ?? null)
      gl.uniform1i(blit.uniforms.get('u_fx') ?? null, 1)
      gl.uniform1f(blit.uniforms.get('u_mix') ?? null, 0)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    gl.bindVertexArray(null)
    return this.canvas
  }
}

let shared: FxGl | undefined

/** The process-wide pipeline; `null` while no GL context exists. */
export function fxGl(): FxGl | null {
  if (shared === undefined) shared = new FxGl()
  return shared.available ? shared : null
}
