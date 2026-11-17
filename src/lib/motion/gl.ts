/**
 * src/lib/motion/gl.ts — the WebGL2 effect pass. The 2D compositor paints the
 * scene; tracks that carry an effect stack (camera track, adjustment layers,
 * any element track) run here as one fullscreen pass per effect over
 * ping-pong FBOs. Seek-safe by construction: uniforms are evaluated at t, the
 * only entropy comes from a seed uniform, and the pipeline holds no state
 * between calls — the same (composition, t) always produces the same pixels.
 *
 * `glslBodies` answers which registry ids ship a GLSL body and
 * `supportedStack` partitions a stack so the caller can report what the
 * preview could not draw instead of drawing it wrong. The bodies are
 * clean-room GLSL implementations of the standard algorithms (box/gaussian
 * taps, luminance ops, hash noise, distance fields) — no code is copied.
 */

import { GL_EFFECT_IDS, effectSeed, effectSpec } from '../../../shared/motionFx.ts'
import type { EffectInstance } from '../../../shared/motion.ts'

const QUAD_VERT = `#version 300 es
layout(location=0) in vec2 a;
out vec2 uv;
void main(){ uv = a * 0.5 + 0.5; gl_Position = vec4(a, 0., 1.); }`

/** u_tex is the incoming pass and u_tex2 the effect's own input (the second
 * input a `needsInput` effect reads — self-mapped until instances can bind a
 * texture — and the source a multi-pass effect composites onto); every body
 * writes `col`. `u_seed`, `u_res`, `u_t` and `u_fps` are always bound; each
 * param of the spec arrives as `u_<param>` (float; vec3 + a `u_<param>_a`
 * alpha float for colors, vec2 for points, the option index for selects). A
 * string[] is an ordered chain of sub-passes — bloom and lens blur pay their
 * cost in bounded extra taps, each reading the previous pass on u_tex. */
const BODY: Record<string, string | readonly string[]> = {
  'gaussian-blur': `col = vec4(0.);
    float r = u_radius / u_res.x;
    float w[5]; w[0]=.227; w[1]=.194; w[2]=.121; w[3]=.054; w[4]=.016;
    for(int i=-4;i<=4;i++) col += texture(u_tex, uv + vec2(float(i), 0.)*r*.25) * w[abs(i)];
    for(int i=-4;i<=4;i++) col += texture(u_tex, uv + vec2(0., float(i))*r*.25) * w[abs(i)];
    col *= .5;`,
  'directional-blur': `col = vec4(0.);
    vec2 d = vec2(cos(radians(u_angle)), sin(radians(u_angle))) * u_radius / u_res;
    for(int i=-8;i<=8;i++) col += texture(u_tex, uv + d*float(i)/8.);
    col /= 17.;`,
  'radial-blur': `col = vec4(0.);
    vec2 c = uv - u_center;
    for(int i=0;i<16;i++){
      float t = float(i)/16.;
      float a = u_mode > .5 ? t * u_amount * .5 : 0.;
      vec2 rc = vec2(c.x*cos(a) - c.y*sin(a), c.x*sin(a) + c.y*cos(a));
      float z = u_mode < .5 ? 1. - t*u_amount : 1.;
      col += texture(u_tex, u_center + rc*z);
    }
    col /= 16.;`,
  /* three skewed gathers along 0°, 60° and 120° — their convolution is a
     hexagonal kernel, and the luminance weight makes bright points bloom
     into discs (the bokeh look a disc kernel gives) */
  'lens-blur': [
    `vec3 acc = vec3(0.); float ws = 0.; float r = u_radius / u_res.x;
    for(int i=-8;i<=8;i++){
      vec3 t3 = texture(u_tex, uv + vec2(float(i)*r*.125, 0.)).rgb;
      float w = 1. + u_bokeh * 6. * smoothstep(.55, 1., doopLuma(t3));
      acc += t3*w; ws += w;
    }
    col = vec4(acc/ws, texture(u_tex, uv).a);`,
    `vec3 acc = vec3(0.); float ws = 0.; float r = u_radius / u_res.x;
    vec2 d = vec2(-.5, .866);
    for(int i=-8;i<=8;i++){
      vec3 t3 = texture(u_tex, uv + float(i)*r*.125*d).rgb;
      float w = 1. + u_bokeh * 6. * smoothstep(.55, 1., doopLuma(t3));
      acc += t3*w; ws += w;
    }
    col = vec4(acc/ws, texture(u_tex, uv).a);`,
    `vec3 acc = vec3(0.); float ws = 0.; float r = u_radius / u_res.x;
    vec2 d = vec2(-.5, -.866);
    for(int i=-8;i<=8;i++){
      vec3 t3 = texture(u_tex, uv + float(i)*r*.125*d).rgb;
      float w = 1. + u_bokeh * 6. * smoothstep(.55, 1., doopLuma(t3));
      acc += t3*w; ws += w;
    }
    col = vec4(acc/ws, texture(u_tex, uv).a);`,
  ],
  glow: `vec3 s = texture(u_tex, uv).rgb;
    vec3 bl = vec3(0.);
    float r = u_radius / u_res.x;
    for(int i=-4;i<=4;i++)
      bl += max(texture(u_tex, uv + vec2(float(i))*r*.25).rgb - vec3(u_threshold), vec3(0.));
    col = vec4(clamp(s + bl * u_intensity * u_tint / 9., 0., 1.), texture(u_tex, uv).a);`,
  vignette: `vec4 s = texture(u_tex, uv);
    float d = distance(uv, vec2(.5)) * 1.4142;
    float v = smoothstep(u_radius, u_radius + (1.5 - u_radius) * u_feather + 1e-3, d);
    col = vec4(mix(s.rgb, u_color, v * u_amount), s.a);`,
  'chromatic-aberration': `vec2 c = uv - u_center;
    vec2 d = (u_falloff < .5 ? normalize(c + vec2(1e-4)) * u_amount : c * u_amount * 3.) / u_res;
    col = vec4(texture(u_tex, uv + d).r, texture(u_tex, uv).g, texture(u_tex, uv - d).b,
      texture(u_tex, uv).a);`,
  'barrel-distortion': `vec2 c = uv - u_center;
    float r2 = dot(c, c);
    vec2 u2 = u_center + c * (1. + u_amount * r2);
    col = (u2.x<0.||u2.x>1.||u2.y<0.||u2.y>1.) ? vec4(0.) : texture(u_tex, u2);`,
  'film-grain': `vec4 s = texture(u_tex, uv);
    vec2 cell = floor(gl_FragCoord.xy / max(u_size, 1.));
    vec3 g = u_mono > .5
      ? vec3(doopHashf(uvec2(ivec2(cell)), uint(u_seed)))
      : vec3(doopHashf(uvec2(ivec2(cell)), uint(u_seed)),
             doopHashf(uvec2(ivec2(cell) + ivec2(61, 0)), uint(u_seed)),
             doopHashf(uvec2(ivec2(cell) + ivec2(0, 61)), uint(u_seed)));
    col = vec4(clamp(s.rgb + (g - .5) * u_amount, 0., 1.), s.a);`,
  noise: `vec4 s = texture(u_tex, uv);
    vec2 cell = floor(gl_FragCoord.xy * u_scale);
    vec3 n = u_mono > .5
      ? vec3(doopHashf(uvec2(ivec2(cell)), uint(u_seed)))
      : vec3(doopHashf(uvec2(ivec2(cell)), uint(u_seed)),
             doopHashf(uvec2(ivec2(cell) + ivec2(61, 0)), uint(u_seed)),
             doopHashf(uvec2(ivec2(cell) + ivec2(0, 61)), uint(u_seed)));
    col = vec4(mix(s.rgb, n, u_amount), s.a);`,
  scanlines: `vec4 s = texture(u_tex, uv);
    float l = .5 + .5 * sin((uv.y * u_count + u_t * u_speed) * 3.14159);
    col = vec4(s.rgb * mix(1., l, u_opacity), s.a);`,
  halftone: `vec4 s = texture(u_tex, uv);
    float ca = cos(radians(u_angle)), sa = sin(radians(u_angle));
    vec2 g = vec2(gl_FragCoord.x*ca - gl_FragCoord.y*sa, gl_FragCoord.x*sa + gl_FragCoord.y*ca)
      / max(u_size, 1.);
    float rr = sqrt(1. - doopLuma(s.rgb)) * .62;
    float aa = .01 + u_softness * .12;
    col = vec4(vec3(1. - smoothstep(rr - aa, rr + aa, length(fract(g) - .5))), s.a);`,
  pixelate: `vec2 p = gl_FragCoord.xy / max(u_size, 1.);
    float row = mod(floor(p.y), 2.) * .5;
    vec2 q = u_mode < .5 ? p
      : u_mode < 1.5 ? vec2((p.x - p.y) * .7071, (p.x + p.y) * .7071)
      : vec2(p.x + row, p.y);
    vec2 cell = floor(q) + .5;
    vec2 px = u_mode < .5 ? cell
      : u_mode < 1.5 ? vec2((cell.x + cell.y) * .7071, (cell.y - cell.x) * .7071)
      : vec2(cell.x - row, cell.y);
    col = texture(u_tex, px * u_size / u_res);`,
  'wave-warp': `vec2 dir = vec2(cos(radians(u_angle)), sin(radians(u_angle)));
    vec2 per = vec2(-dir.y, dir.x);
    float phase = dot(gl_FragCoord.xy, per) * 6.28318 / max(u_wavelength, 1.) + u_t * u_speed;
    col = texture(u_tex, uv + dir * sin(phase) * u_amplitude / u_res);`,
  'bulge-pinch': `vec2 c = uv - u_center; float d = length(c * u_res/u_res.y);
    float s = smoothstep(u_radius, 0., d);
    col = texture(u_tex, u_center + c * (1. - u_amount*s));`,
  mirror: `vec2 p = uv - u_center;
    float ca = cos(radians(u_angle)), sa = sin(radians(u_angle));
    vec2 q = vec2(p.x*ca + p.y*sa, -p.x*sa + p.y*ca);
    if(u_reflect < .5){ if(q.x > 0.) q.x = -q.x; }
    else if(u_reflect < 1.5){ if(q.x < 0.) q.x = -q.x; }
    else if(u_reflect < 2.5){ if(q.y > 0.) q.y = -q.y; }
    else if(q.y < 0.){ q.y = -q.y; }
    col = texture(u_tex, u_center + vec2(q.x*ca - q.y*sa, q.x*sa + q.y*ca));`,
  'color-grade': `vec4 s = texture(u_tex, uv);
    vec3 x = s.rgb * pow(2., u_exposure);
    x += vec3(u_temperature, u_temperature * .5, -u_temperature) * .15;
    float lum = dot(x, vec3(.2126, .7152, .0722));
    x = mix(vec3(lum), x, 1. + u_saturation);
    x = (x - .5) * (1. + u_contrast) + .5;
    x += u_shadows * u_split * (1. - lum) + (u_highlights - 1.) * u_split * lum;
    col = vec4(clamp(x, 0., 1.), s.a);`,
  tint: `vec4 s = texture(u_tex, uv);
    float lum = dot(s.rgb, vec3(.2126,.7152,.0722));
    col = vec4(mix(s.rgb, u_color*lum, u_amount), s.a);`,
  duotone: `vec4 s = texture(u_tex, uv);
    float lum = dot(s.rgb, vec3(.2126,.7152,.0722));
    col = vec4(mix(s.rgb, mix(u_shadow, u_highlight, lum), u_amount), s.a);`,
  invert: `vec4 s = texture(u_tex, uv);
    float a = u_alpha > .5 ? mix(s.a, 1. - s.a, u_amount) : s.a;
    col = vec4(mix(s.rgb, vec3(1.) - s.rgb, u_amount), a);`,
  posterize: `vec4 s = texture(u_tex, uv);
    col = vec4(floor(s.rgb * u_levels + .5) / u_levels, s.a);`,
  'hue-shift': `vec4 s = texture(u_tex, uv);
    vec3 k = vec3(.57735); float a = radians(u_degrees);
    col = vec4(s.rgb*cos(a) + cross(k,s.rgb)*sin(a) + k*dot(k,s.rgb)*(1.-cos(a)), s.a);`,
  'rgb-split': `float j = (doopHashf(uvec2(uint(gl_FragCoord.y), uint(floor(u_t * u_fps))),
      uint(u_seed)) - .5) * u_jitter;
    vec2 d = vec2(cos(radians(u_angle)), sin(radians(u_angle))) * u_amount * (1. + j) / u_res;
    col = vec4(texture(u_tex, uv+d).r, texture(u_tex, uv).g, texture(u_tex, uv-d).b,
      texture(u_tex, uv).a);`,
  'block-shift': `vec2 u2 = uv;
    uint row = uint(floor(uv.y * u_rows));
    uint frame = uint(floor(u_t * u_rate));
    float h = doopHashf(uvec2(row, frame), uint(u_seed));
    float h2 = doopHashf(uvec2(row, frame + 977u), uint(u_seed));
    if(h < .35) u2.x = fract(u2.x + (h2 - .5) * u_amount / u_res.x);
    col = texture(u_tex, u2);`,
  'scan-jitter': `vec2 u2 = uv;
    uint row = uint(floor(uv.y * u_frequency));
    uint frame = uint(floor(u_t * u_rate));
    float h = doopHashf(uvec2(row, frame), uint(u_seed));
    u2.x = fract(u2.x + (h - .5) * u_amount / u_res.x);
    col = texture(u_tex, u2);`,
  'light-leak': `vec4 s = texture(u_tex, uv);
    float an = doopHashf(uvec2(3u, 7u), uint(u_seed)) * 6.28318;
    vec2 c = u_position + vec2(cos(an), sin(an)) * u_drift * u_t * .02;
    float leak = smoothstep(u_size, 0., distance(uv, c)) * u_opacity;
    col = vec4(clamp(s.rgb + u_color * leak, 0., 1.), s.a);`,
  /* threshold pass, then a separable gaussian over the bright pass; the last
     sub-pass composites the blur onto the untouched input on u_tex2 */
  bloom: [
    `vec3 s = texture(u_tex, uv).rgb;
    float l = doopLuma(s);
    col = vec4(s * smoothstep(u_threshold - .1, u_threshold + .1, l), 1.);`,
    `vec3 acc = vec3(0.);
    float r = u_radius / u_res.x;
    float w[5]; w[0]=.227; w[1]=.194; w[2]=.121; w[3]=.054; w[4]=.016;
    for(int i=-4;i<=4;i++) acc += texture(u_tex, uv + vec2(float(i), 0.)*r*.25).rgb * w[abs(i)];
    col = vec4(acc, 1.);`,
    `vec3 acc = vec3(0.);
    float r = u_radius / u_res.y;
    float w[5]; w[0]=.227; w[1]=.194; w[2]=.121; w[3]=.054; w[4]=.016;
    for(int i=-4;i<=4;i++) acc += texture(u_tex, uv + vec2(0., float(i))*r*.25).rgb * w[abs(i)];
    vec4 s = texture(u_tex2, uv);
    col = vec4(clamp(s.rgb + acc * u_intensity, 0., 1.), s.a);`,
  ],
  curves: `vec4 s = texture(u_tex, uv);
    vec3 x = clamp((s.rgb - vec3(u_black)) / max(u_white - u_black, 1e-3), 0., 1.);
    col = vec4(clamp(pow(x, vec3(1. / u_gamma)) + vec3(u_lift), 0., 1.), s.a);`,
  /* the matte channel comes off the second input (u_tex2 — the layer's own
     picture until instances can bind a texture), so a luma matte keys the
     layer on its own luminance */
  'luma-matte': `vec4 s = texture(u_tex, uv);
    vec4 m4 = texture(u_tex2, uv);
    float m = u_channel < .5 ? doopLuma(m4.rgb)
      : u_channel < 1.5 ? m4.a
      : u_channel < 2.5 ? m4.r
      : u_channel < 3.5 ? m4.g
      : m4.b;
    if(u_invert > .5) m = 1. - m;
    m = smoothstep(u_softness * .5, 1. - u_softness * .5, m);
    col = vec4(s.rgb, s.a * m);`,
  feather: `vec4 s = texture(u_tex, uv);
    float r = u_amount / u_res.x;
    float a = 0.;
    for(int i=-2;i<=2;i++)
      for(int j=-2;j<=2;j++)
        a += texture(u_tex, uv + vec2(float(i), float(j)) * r * .5).a;
    col = vec4(s.rgb, a / 25.);`,
  choke: `vec4 s = texture(u_tex, uv);
    float r = abs(u_amount) / u_res.x;
    float a = s.a;
    for(int i=0;i<8;i++){
      float an = float(i) * .7853982;
      float b = texture(u_tex, uv + vec2(cos(an), sin(an)) * r).a;
      a = u_amount < 0. ? min(a, b) : max(a, b);
    }
    col = vec4(s.rgb, a);`,
  /* a core disc plus ghosts spread along the axis through the frame
     centre — the mirrored line a lens flare draws; even ghosts land as
     discs, odd ones as rings */
  'lens-flare': `vec4 s = texture(u_tex, uv);
    vec2 axis = vec2(.5) - u_position;
    vec3 flare = vec3(smoothstep(.07, 0., distance(uv, u_position)) * 1.4);
    for(int i=1;i<=8;i++){
      if(float(i) > u_ghosts) break;
      vec2 g = u_position + axis * (float(i) / (u_ghosts + 1.) * 2.);
      float sz = .015 + .05 * float(i) / 8.;
      float disc = smoothstep(sz, sz * .55, distance(uv, g));
      float ring = smoothstep(.012, 0., abs(distance(uv, g) - sz));
      flare += mix(disc, ring, mod(float(i), 2.)) * (.3 + .12 * float(i) / 8.);
    }
    col = vec4(clamp(s.rgb + flare * u_tint * u_intensity, 0., 1.), s.a);`,
  /* crepuscular shafts: a decaying gather along the ray to the light
     source, so bright matter streaks outward from it */
  'god-rays': `vec4 s = texture(u_tex, uv);
    vec2 d = (uv - u_source) * u_density / 48.;
    vec2 p = uv;
    float w = 1., ws = 0., acc = 0.;
    for(int i=0;i<48;i++){
      p -= d;
      acc += doopLuma(texture(u_tex, p).rgb) * w;
      ws += w;
      w *= u_decay;
    }
    col = vec4(clamp(s.rgb + acc / max(ws, 1e-4) * u_intensity, 0., 1.), s.a);`,
  /* Brown–Conrady radial model, aspect-corrected around the centre */
  'lens-distortion': `vec2 c = (uv - u_center) * vec2(u_res.x / u_res.y, 1.);
    float r2 = dot(c, c);
    vec2 u2 = u_center + c * (1. + u_k1 * r2 + u_k2 * r2 * r2) / vec2(u_res.x / u_res.y, 1.);
    col = (u2.x<0.||u2.x>1.||u2.y<0.||u2.y>1.) ? vec4(0.) : texture(u_tex, u2);`,
  /* each scanline exposes a little later than the last — a linear skew
     across the readout axis */
  'rolling-shutter': `vec2 u2 = uv;
    if(u_axis < .5) u2.x += (uv.y - .5) * u_amount / u_res.x;
    else u2.y += (uv.x - .5) * u_amount / u_res.y;
    col = texture(u_tex, u2);`,
  /* a one-sided streak: taps spread by the speed curve behind the travel
     direction, weights falling off linearly */
  'whip-blur': `col = vec4(0.);
    vec2 d = vec2(cos(radians(u_angle)), sin(radians(u_angle))) * u_amount * .3;
    float ws = 0.;
    for(int i=0;i<16;i++){
      float t = float(i) / 15.;
      float w = 1. - t;
      col += texture(u_tex, uv - d * pow(t, u_curve)) * w;
      ws += w;
    }
    col /= ws;`,
  /* the second input (u_tex2 — self-mapped until instances bind one) is the
     height field: two decorrelated reads give the 2D offset */
  'displacement-map': `vec4 m4 = texture(u_tex2, uv);
    vec4 m4b = texture(u_tex2, fract(uv + vec2(.5)));
    float mx = u_channel < .5 ? m4.r : u_channel < 1.5 ? m4.g : doopLuma(m4.rgb);
    float my = u_channel < .5 ? m4b.r : u_channel < 1.5 ? m4b.g : doopLuma(m4b.rgb);
    col = texture(u_tex, uv + (vec2(mx, my) - .5) * 2. * u_amount / u_res);`,
  /* a two-octave value-noise vector field; evolution scrolls the field's
     phase with t, deterministic per seed — never a clock */
  'turbulent-displace': `vec2 p = uv * u_scale * 8.;
    vec2 q = p + vec2(u_t * u_evolution, u_t * u_evolution * .7);
    vec2 o = vec2(
      doopVnoise(q, uint(u_seed)) + doopVnoise(q * 2.7 + vec2(11.1), uint(u_seed) + 53u) * .5,
      doopVnoise(q + vec2(31.7, 17.3), uint(u_seed)) + doopVnoise(q * 2.7 + vec2(47.9), uint(u_seed) + 53u) * .5);
    col = texture(u_tex, uv + (o / 1.5 - .5) * u_amount / u_res);`,
  /* the column (axis x) or row (axis y) at position is stretched out:
     samples far from the slit pull toward it, near ones hold */
  'slit-stretch': `vec2 u2 = uv;
    float d = (u_axis < .5 ? uv.x : uv.y) - u_position;
    float f = mix(1., 1. - u_stretch, smoothstep(0., .35, abs(d)));
    if(u_axis < .5) u2.x = u_position + d * f;
    else u2.y = u_position + d * f;
    col = texture(u_tex, u2);`,
  'gradient-ramp': `vec2 dir = vec2(cos(radians(u_angle)), sin(radians(u_angle)));
    float t = u_shape < .5 ? dot(uv - .5, dir) + .5 : distance(uv, vec2(.5)) * 1.4142;
    col = mix(vec4(u_from, u_from_a), vec4(u_to, u_to_a), clamp(t, 0., 1.));`,
  /* fbm over the integer-lattice value noise; evolution scrolls the field
     with t, deterministic per seed */
  'fractal-noise': `vec2 p = uv * u_scale * 8.;
    float sum = 0., amp = .5, norm = 0.;
    for(int o=0;o<8;o++){
      if(float(o) >= u_octaves) break;
      vec2 q = p + vec2(u_t * u_evolution * .5, -u_t * u_evolution * .3) + float(o) * 17.13;
      sum += doopVnoise(q, uint(u_seed)) * amp;
      norm += amp; amp *= .5; p *= 2.03;
    }
    float n = sum / max(norm, 1e-4);
    col = vec4(vec3(clamp((n - .5) * u_contrast + .5, 0., 1.)), 1.);`,
  grid: `vec2 g = mod(gl_FragCoord.xy, u_size);
    float d = min(min(g.x, u_size - g.x), min(g.y, u_size - g.y));
    float on = 1. - smoothstep(u_line * .5, u_line * .5 + 1., d);
    vec4 ln = vec4(u_color, u_color_a);
    col = mix(vec4(u_background, u_background_a), ln, on * ln.a);`,
  'solid-fill': `col = vec4(u_color, u_color_a);`,
}

/* an integer hash, not a sine hash: sin()'s precision is implementation-
 * defined across GPUs, so a float hash renders a different film on a
 * different card — uint arithmetic is exact everywhere. lowbias32
 * (Chris Wellons' constant set) mixed down to 24 bits so the float it
 * becomes is still exact */
const LIB_GLSL = `
uint doopHash(uint x) {
  x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u;
  return x;
}
float doopHashf(uvec2 p, uint seed) {
  uint h = doopHash((p.x * 0x9E3779B9u) ^ doopHash(p.y + 0x85EBCA6Bu) ^ doopHash(seed));
  return float(h & 0x00FFFFFFu) * (1.0 / 16777216.0);
}
float doopLuma(vec3 c) { return dot(c, vec3(.2126, .7152, .0722)); }
/* bilinear value noise over the integer lattice — the deterministic field
   turbulent displace and fractal noise sample */
float doopVnoise(vec2 p, uint seed) {
  vec2 i = floor(p), f = fract(p);
  vec2 w = f * f * (3. - 2. * f);
  float a = doopHashf(uvec2(ivec2(i)), seed);
  float b = doopHashf(uvec2(ivec2(i) + ivec2(1, 0)), seed);
  float c = doopHashf(uvec2(ivec2(i) + ivec2(0, 1)), seed);
  float d = doopHashf(uvec2(ivec2(i) + ivec2(1, 1)), seed);
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}`

const FRAG = (body: string, params: readonly { id: string; kind: string }[]) => `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform sampler2D u_tex2;
uniform vec2 u_res;
uniform float u_seed;
uniform float u_t;
uniform float u_fps;
${params
  .map((p) => {
    const name = `u_${p.id.replace(/-/g, '_')}`
    if (p.kind === 'color') return `uniform vec3 ${name};\nuniform float ${name}_a;`
    return `uniform ${p.kind === 'point' ? 'vec2' : 'float'} ${name};`
  })
  .join('\n')}
in vec2 uv;
out vec4 col;
${LIB_GLSL}
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

/** the pass chain an effect's BODY describes — one entry, or the bounded
 *  sub-passes a multi-pass effect pays its cost in (tests read the same
 *  list to prove every declared uniform is honored) */
export function glslBodies(fxId: string): readonly string[] {
  const b = BODY[fxId]
  return b === undefined ? [] : typeof b === 'string' ? [b] : b
}

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

const uniformName = (id: string) => `u_${id.replace(/-/g, '_')}`

/** One GL context, a program per used effect pass, two ping-pong textures
 * plus a scratch one (`tex[2]`) for the input snapshot multi-pass effects
 * read on `u_tex2` and for a mix that would otherwise feed back. All scratch
 * state lives here — `apply` itself is a pure function of its args. */
export class FxGl {
  private gl: Gl | null = null
  private canvas: HTMLCanvasElement
  private programs = new Map<string, Program | null>()
  private fbo: (WebGLFramebuffer | null)[] = [null, null, null]
  private tex: (WebGLTexture | null)[] = [null, null, null]
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
    this.fbo = [gl.createFramebuffer() ?? null, gl.createFramebuffer() ?? null, gl.createFramebuffer() ?? null]
    this.tex = [gl.createTexture() ?? null, gl.createTexture() ?? null, gl.createTexture() ?? null]
    this.srcTex = gl.createTexture() ?? null
  }

  private program(fxId: string, pass: number): Program | null {
    const key = pass === 0 ? fxId : `${fxId}#${pass}`
    const cached = this.programs.get(key)
    if (cached !== undefined) return cached
    const gl = this.gl as Gl
    const spec = effectSpec(fxId)
    const body = glslBodies(fxId)[pass]
    if (!spec || !body || !gl) {
      this.programs.set(key, null)
      return null
    }
    const vs = compile(gl, gl.VERTEX_SHADER, QUAD_VERT)
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG(body, spec.params))
    const prog = vs && fs ? gl.createProgram() : null
    if (!vs || !fs || !prog) {
      this.programs.set(key, null)
      return null
    }
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      this.programs.set(key, null)
      return null
    }
    const uniforms = new Map<string, WebGLUniformLocation | null>()
    for (const name of [
      'u_tex',
      'u_tex2',
      'u_res',
      'u_seed',
      'u_t',
      'u_fps',
      ...spec.params.flatMap((p) =>
        p.kind === 'color' ? [uniformName(p.id), `${uniformName(p.id)}_a`] : [uniformName(p.id)],
      ),
    ]) {
      uniforms.set(name, gl.getUniformLocation(prog, name))
    }
    const entry = { prog, uniforms }
    this.programs.set(key, entry)
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
    for (let i = 0; i < this.fbo.length; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[i] ?? null)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex[i] ?? null, 0)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  /** Run `stack` over `src` and return the composited canvas plus the ids
   * whose pass failed (missing or uncompilable body — the caller reports
   * them instead of letting a broken shader pass for the input). Returns
   * null when the context is unavailable. `fps` is the film's own frame
   * rate, the clock the seeded time-jitters quantize to (not a hard-coded
   * 30). */
  apply(
    src: TexImageSource,
    w: number,
    h: number,
    stack: readonly (EffectInstance & { paramsAt?: Record<string, number | string | boolean> })[],
    t: number,
    fps: number,
  ): { canvas: HTMLCanvasElement; failed: string[] } | null {
    const gl = this.gl
    if (!gl || stack.length === 0) return null
    this.ensureTarget(w, h)
    gl.viewport(0, 0, w, h)
    gl.bindVertexArray(this.vao)

    /* source → srcTex: the first pass and later passes read the same layout */
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex ?? null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource)

    let input: WebGLTexture | null = this.srcTex
    let side = 0
    const failed: string[] = []

    for (const inst of stack) {
      const spec = effectSpec(inst.fx)
      if (!spec || inst.enabled === false) continue
      const bodies = glslBodies(inst.fx)
      if (bodies.length === 0) {
        failed.push(inst.fx)
        continue
      }
      const effectInput = input
      let second = effectInput
      if (bodies.length > 1) {
        /* the sub-passes ping-pong the work buffers and would overwrite the
           effect's input mid-chain, so u_tex2 reads a snapshot on tex[2] */
        const mp = this.mixProgram()
        if (mp) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[2] ?? null)
          gl.useProgram(mp.prog)
          gl.activeTexture(gl.TEXTURE0)
          gl.bindTexture(gl.TEXTURE_2D, effectInput ?? null)
          gl.uniform1i(mp.uniforms.get('u_tex') ?? null, 0)
          gl.activeTexture(gl.TEXTURE1)
          gl.bindTexture(gl.TEXTURE_2D, effectInput ?? null)
          gl.uniform1i(mp.uniforms.get('u_fx') ?? null, 1)
          gl.uniform1f(mp.uniforms.get('u_mix') ?? null, 0)
          gl.drawArrays(gl.TRIANGLES, 0, 3)
          second = this.tex[2] ?? null
        }
      }

      let drew = true
      for (let i = 0; i < bodies.length; i++) {
        const p = this.program(inst.fx, i)
        if (!p) {
          failed.push(inst.fx)
          drew = false
          break
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[side] ?? null)
        gl.useProgram(p.prog)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, input ?? null)
        gl.uniform1i(p.uniforms.get('u_tex') ?? null, 0)
        gl.activeTexture(gl.TEXTURE1)
        gl.bindTexture(gl.TEXTURE_2D, second ?? null)
        gl.uniform1i(p.uniforms.get('u_tex2') ?? null, 1)
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
          const uname = uniformName(param.id)
          const loc = p.uniforms.get(uname)
          const value = params[param.id]
          if (param.kind === 'color') {
            const hex = typeof value === 'string' && value.startsWith('#') ? value : String(param.def)
            if (loc) {
              gl.uniform3f(
                loc,
                parseInt(hex.slice(1, 3), 16) / 255,
                parseInt(hex.slice(3, 5), 16) / 255,
                parseInt(hex.slice(5, 7), 16) / 255,
              )
            }
            const aloc = p.uniforms.get(`${uname}_a`)
            if (aloc) gl.uniform1f(aloc, hex.length >= 9 ? parseInt(hex.slice(7, 9), 16) / 255 : 1)
          } else if (param.kind === 'point') {
            const parts = String(value ?? param.def)
              .split(',')
              .map(Number)
            const u = parts[0] ?? 0.5
            const v = parts[1] ?? 0.5
            if (loc) gl.uniform2f(loc, Number.isFinite(u) ? u : 0.5, Number.isFinite(v) ? v : 0.5)
          } else if (param.kind === 'bool') {
            if (loc) gl.uniform1f(loc, value === true || value === 1 ? 1 : 0)
          } else if (param.kind === 'select') {
            /* a select rides as its option index — strings never reach a
               float uniform (Number('zoom') would be NaN) */
            const opts = param.options ?? []
            const idx = opts.indexOf(String(value ?? param.def))
            if (loc) gl.uniform1f(loc, idx >= 0 ? idx : Math.max(0, opts.indexOf(String(param.def))))
          } else {
            const f = typeof value === 'number' ? value : Number(param.def)
            if (loc) gl.uniform1f(loc, f)
          }
        }
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        input = this.tex[side] ?? null
        side = 1 - side
      }
      if (!drew) {
        /* a mid-chain failure leaves the stack as it was — the buffers are
           scratch, the image chain stays correct */
        input = effectInput
        side = effectInput === this.tex[0] ? 1 : 0
        continue
      }

      /* mix stage: blend the effect over the incoming pixels by inst.mix.
         The write must never read the texture it renders into: a single-sub-
         pass effect leaves its input on the free side, so the mix then lands
         on the scratch texture instead. */
      const mix = typeof inst.mix === 'number' ? Math.min(Math.max(inst.mix, 0), 1) : 1
      if (mix < 1) {
        const mp = this.mixProgram()
        if (mp) {
          const mi = effectInput === this.tex[side] ? 2 : side
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[mi] ?? null)
          gl.useProgram(mp.prog)
          gl.activeTexture(gl.TEXTURE0)
          gl.bindTexture(gl.TEXTURE_2D, effectInput ?? null)
          gl.uniform1i(mp.uniforms.get('u_tex') ?? null, 0)
          gl.activeTexture(gl.TEXTURE1)
          gl.bindTexture(gl.TEXTURE_2D, input ?? null)
          gl.uniform1i(mp.uniforms.get('u_fx') ?? null, 1)
          gl.uniform1f(mp.uniforms.get('u_mix') ?? null, mix)
          gl.drawArrays(gl.TRIANGLES, 0, 3)
          input = this.tex[mi] ?? null
          side = mi === 2 ? 0 : 1 - mi
        }
      }
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
    return { canvas: this.canvas, failed }
  }
}

let shared: FxGl | undefined

/** The process-wide pipeline; `null` while no GL context exists. */
export function fxGl(): FxGl | null {
  if (shared === undefined) shared = new FxGl()
  return shared.available ? shared : null
}
