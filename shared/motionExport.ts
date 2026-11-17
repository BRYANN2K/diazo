/**
 * shared/motionExport.ts — "copy as code" (proposal 14.2): a composition's
 * layer keyframes, camera, transitions and text animators exported as CSS
 * `@keyframes` plus a matching WAAPI script a developer can paste into a
 * real page. Token names are kept (`var(--ease-*)` in CSS, a kept name in
 * WAAPI) — a token change still retimes the exported motion. Springs have
 * no CSS form, so they compile to `linear()` sampled from the same
 * springProgress the runtime evaluates — pixel-equal, and marked.
 */

import {
  CAMERA_PROPERTIES,
  elementKey,
  type Composition,
  type FrameMotionKeyframe,
  type FrameTextAnimator,
  type MotionClip,
  type MotionEasing,
  type MotionKeyframe,
} from './motion.ts'
import { keyframeLanes, laneValueAt, springProgress, type ResolveEasing } from './motionRuntime.ts'
import { expandTextAnimator } from './motionText.ts'

export interface MotionExportFile {
  name: string
  content: string
}

export interface CompositionCodeExport {
  files: MotionExportFile[]
  /** every `--ease-*`/`--spring-*`/`--dur-*` token the export references */
  tokens: string[]
  /** what the export could not express exactly */
  notes: string[]
}

export interface ExportCodeOptions {
  /** frame-authored motion (`data-doop-motion` blocks), per frame id */
  frameBlocks?: ReadonlyMap<string, { keyframes?: FrameMotionKeyframe[]; animators?: FrameTextAnimator[] }>
  /** text of each animated element for animator expansion:
   *  frameId → elementId → textContent */
  frameTexts?: ReadonlyMap<string, ReadonlyMap<string, string>>
  /** resolve `--ease-*`/`--spring-*` tokens to curves for sampling;
   *  unresolved tokens keep their name in the output */
  resolveEasing?: ResolveEasing
}

const fmt = (n: number) => (Math.round(n * 1000) / 1000).toString()

/** a MotionEasing as a CSS timing function; tokens keep their name */
export function easingCss(easing: MotionEasing, resolve?: ResolveEasing): string {
  const e = easing.type === 'token' ? (resolve?.(easing.name) ?? easing) : easing
  switch (e.type) {
    case 'linear':
      return 'linear'
    case 'hold':
      /* CSS: stay on the from-value until the next stop */
      return 'steps(1)'
    case 'steps':
      return `steps(${e.steps}, ${e.position === 'start' ? 'jump-start' : 'jump-end'})`
    case 'cubic-bezier':
      return `cubic-bezier(${e.x1}, ${e.y1}, ${e.x2}, ${e.y2})`
    case 'spring': {
      /* no CSS spring — sample the same curve the runtime evaluates into
         linear(), which every modern engine accepts */
      const pts: string[] = ['0']
      for (let i = 1; i <= 10; i++) {
        const u = i / 10
        const p = springProgress(e.stiffness, e.damping, e.mass, u)
        pts.push(`${fmt(Math.round(p * 1000) / 1000)} ${Math.round(u * 100)}%`)
      }
      return `linear(${pts.join(', ')})`
    }
    case 'token':
      return `var(${e.name})`
  }
}

/** the CSS declaration a property/value pair becomes inside a keyframe */
function cssDecl(prop: string, value: number | string, units: Record<string, string>): string | null {
  if (prop.startsWith('--')) return `${prop}: ${value}`
  const unit = units[prop] ?? ''
  const v = typeof value === 'number' ? `${fmt(value)}${unit}` : value
  const name = prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)
  return `${name}: ${v}`
}

/** transform-family properties compose into one `transform` per stop */
const TRANSFORM_PROPS = ['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotate', 'skewX', 'skewY'] as const
/** filter-family properties compose into one `filter` */
const FILTER_PROPS = ['blur', 'brightness', 'contrast', 'saturate', 'grayscale', 'hue-rotate'] as const

const CSS_UNITS: Record<string, string> = {
  x: 'px',
  y: 'px',
  rotate: 'deg',
  skewX: 'deg',
  skewY: 'deg',
  blur: 'px',
  'hue-rotate': 'deg',
  borderRadius: 'px',
  strokeDashoffset: 'px',
}

const FILTER_DEFAULTS: Record<string, number> = {
  blur: 0,
  brightness: 1,
  contrast: 1,
  saturate: 1,
  grayscale: 0,
  'hue-rotate': 0,
}

/** build `transform: translate(x,y) scale(sx,sy) rotate(r) skewX() skewY()` */
function transformAt(props: Record<string, number | string>): string {
  const num = (p: string, d: number) => (typeof props[p] === 'number' ? (props[p] as number) : d)
  const x = num('x', 0)
  const y = num('y', 0)
  const sx = num('scaleX', num('scale', 1))
  const sy = num('scaleY', num('scale', 1))
  const rotate = num('rotate', 0)
  const kx = num('skewX', 0)
  const ky = num('skewY', 0)
  const parts: string[] = []
  if (x || y) parts.push(`translate(${fmt(x)}px, ${fmt(y)}px)`)
  if (sx !== 1 || sy !== 1) parts.push(`scale(${fmt(sx)}, ${fmt(sy)})`)
  if (rotate) parts.push(`rotate(${fmt(rotate)}deg)`)
  if (kx) parts.push(`skewX(${fmt(kx)}deg)`)
  if (ky) parts.push(`skewY(${fmt(ky)}deg)`)
  return parts.length ? `transform: ${parts.join(' ')}` : 'transform: none'
}

/** build `filter: blur() brightness() …` for the filter family */
function filterAt(props: Record<string, number | string>): string {
  const num = (p: string) => (typeof props[p] === 'number' ? (props[p] as number) : FILTER_DEFAULTS[p]!)
  const parts: string[] = []
  for (const p of FILTER_PROPS) {
    if (props[p] === undefined) continue
    const unit = CSS_UNITS[p] ?? ''
    parts.push(`${p}(${fmt(num(p))}${unit})`)
  }
  return parts.length ? `filter: ${parts.join(' ')}` : 'filter: none'
}

interface LaneSet {
  /** the merged lanes for one target: prop → sorted keyframes */
  lanes: Map<string, MotionKeyframe[]>
}

/** merge a composition's animated targets: element tracks + frame blocks
 *  + expanded text animators, element tracks winning a same-prop lane */
function collectTargets(comp: Composition, opts?: ExportCodeOptions): Map<string, LaneSet> {
  const targets = new Map<string, LaneSet>()
  const laneInto = (target: string, kfs: readonly (MotionKeyframe | FrameMotionKeyframe)[]) => {
    const set = targets.get(target) ?? { lanes: new Map() }
    targets.set(target, set)
    for (const raw of kfs) {
      const kf: MotionKeyframe =
        'property' in raw
          ? raw
          : {
              id: `${target}/${raw.prop}/${raw.t}`,
              property: raw.prop,
              t: raw.t,
              value: raw.value,
              easing: raw.ease ?? { type: 'linear' },
            }
      const lane = set.lanes.get(kf.property)
      if (lane) lane.push(kf)
      else set.lanes.set(kf.property, [kf])
    }
  }

  for (const [frameId, block] of opts?.frameBlocks ?? []) {
    for (const kf of block.keyframes ?? []) laneInto(elementKey(frameId, kf.el), [kf])
    for (const animator of block.animators ?? []) {
      const text = opts?.frameTexts?.get(frameId)?.get(animator.el) ?? animator.el
      const { keyframes } = expandTextAnimator(animator, text)
      for (const kf of keyframes) laneInto(elementKey(frameId, kf.el), [kf])
    }
  }
  /* element tracks override the same property lane on the same target —
     matching frameStateAt's merge order */
  for (const track of comp.tracks) {
    if (track.kind !== 'element' || track.muted || !track.frameId || !track.elementId) continue
    const target = elementKey(track.frameId, track.elementId)
    const set = targets.get(target) ?? { lanes: new Map() }
    targets.set(target, set)
    for (const [prop, lane] of keyframeLanes(track.keyframes ?? [])) set.lanes.set(prop, lane)
  }
  for (const set of targets.values()) for (const lane of set.lanes.values()) lane.sort((a, b) => a.t - b.t)
  return targets
}

const safeName = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_')

/** one stop's declarations at time t across the lane set */
function stopDecls(lanes: Map<string, MotionKeyframe[]>, t: number, resolve?: ResolveEasing): string[] {
  const props: Record<string, number | string> = {}
  const plain: [string, string][] = []
  for (const [prop, lane] of lanes) props[prop] = laneValueAt(lane, t, resolve)
  for (const [prop, value] of Object.entries(props)) {
    if ((TRANSFORM_PROPS as readonly string[]).includes(prop) || (FILTER_PROPS as readonly string[]).includes(prop))
      continue
    const decl = cssDecl(prop, value, CSS_UNITS)
    if (decl) plain.push([prop, decl])
  }
  const decls = plain.map(([, d]) => d)
  if (Object.keys(props).some((p) => (TRANSFORM_PROPS as readonly string[]).includes(p))) decls.push(transformAt(props))
  if (Object.keys(props).some((p) => (FILTER_PROPS as readonly string[]).includes(p))) decls.push(filterAt(props))
  return decls
}

function targetSelector(target: string): string {
  /* 'frameId/el' → scoped selector; 'frameId/el[i]' (a split unit) → the
     unit index inside the split element */
  const slash = target.indexOf('/')
  const frameId = target.slice(0, slash)
  const el = target.slice(slash + 1)
  const unit = /^(.*)\[(\d+)\]$/.exec(el)
  const base = `[data-frame="${frameId}"] [data-doop-id="${unit ? unit[1] : el}"]`
  if (unit) return `${base} [data-doop-unit="${unit[2]}"]`
  return base
}

function collectTokens(comp: Composition, opts?: ExportCodeOptions): string[] {
  const names = new Set<string>()
  const scan = (e?: MotionEasing) => e?.type === 'token' && names.add(e.name)
  for (const track of comp.tracks) {
    for (const kf of track.keyframes ?? []) scan(kf.easing)
    for (const clip of track.clips ?? []) {
      scan(clip.transition?.easing)
      if (clip.transition?.token) names.add(clip.transition.token)
    }
  }
  for (const block of opts?.frameBlocks?.values() ?? []) {
    for (const kf of block.keyframes ?? []) scan(kf.ease)
    for (const a of block.animators ?? []) scan(a.ease)
  }
  return [...names].sort()
}

/** the transition a kind plays, as in-side/out-side WAAPI descriptions */
function transitionNote(clip: MotionClip): string {
  const tr = clip.transition!
  const ease = tr.easing ? easingCss(tr.easing) : 'ease'
  const ms = tr.token
    ? `var(${tr.token}) (=${Math.round(tr.duration * 1000)}ms)`
    : `${Math.round(tr.duration * 1000)}ms`
  const dir = tr.direction ?? 'left'
  switch (tr.kind) {
    case 'dissolve':
      return `dissolve — out: opacity 1→0; in: opacity 0→1 — ${ms}, ${ease}`
    case 'push':
      return `push ${dir} — in: translate from ${dir} edge → 0; out: translate 0 → opposite edge — ${ms}, ${ease}`
    case 'wipe':
      return `wipe ${dir} — in: clip-path inset wipes from the ${dir} — ${ms}, ${ease}`
    case 'zoom':
      return `zoom — in: scale 0.7→1 + opacity; out: scale 1→1.4 + opacity out — ${ms}, ${ease}`
    case 'shared-element':
      return `shared-element — elements with the same data-doop-id in both frames interpolate their boxes — ${ms}, ${ease} (FLIP, computed at build)`
    default:
      return `${tr.kind} — ${ms}, ${ease}`
  }
}

/**
 * Compile a composition to paste-ready code: one `composition.css` with
 * per-target `@keyframes`, one `composition.js` with the same motion as
 * `Element.animate()` calls, plus camera and transition blocks.
 */
export function exportCompositionCode(comp: Composition, opts?: ExportCodeOptions): CompositionCodeExport {
  const notes: string[] = []
  const targets = collectTargets(comp, opts)
  const tokens = collectTokens(comp, opts)
  const dur = comp.duration

  /* ---- CSS ---- */
  const css: string[] = [
    `/* Diazo Motion Studio — "${comp.pageId}" ${fmt(dur)}s @ ${comp.fps}fps, ${comp.width}×${comp.height}`,
    ` * paste into a page whose frames carry data-frame + data-doop-id like the canvas.`,
    ...(tokens.length ? [` * expects motion tokens: ${tokens.join(', ')}`] : []),
    ` */`,
  ]
  const js: string[] = [
    `// Diazo Motion Studio — WAAPI export of "${comp.pageId}" (${fmt(dur)}s @ ${comp.fps}fps)`,
    `// every animation is authored paused against --t: seek = set a time on the clock.`,
    `const DURATION = ${Math.round(dur * 1000)}`,
    ``,
  ]
  if (tokens.length) notes.push(`token easings kept by name: ${tokens.join(', ')}`)

  for (const [target, set] of targets) {
    const selector = targetSelector(target)
    const times = [...new Set([...set.lanes.values()].flatMap((lane) => lane.map((k) => k.t)))].sort((a, b) => a - b)
    if (times.length === 0) continue
    const name = `anim_${safeName(target)}`

    css.push(``, `/* ${selector} */`, `${selector} {`, `  animation: ${name} ${fmt(dur)}s linear both paused;`, `}`)
    css.push(`@keyframes ${name} {`)
    for (const t of times) {
      const pct = (t / dur) * 100
      const decls = stopDecls(set.lanes, t, opts?.resolveEasing)
      /* easing of the segment leaving this stop: the lanes' keyframes at
         t may differ — emit the first (a mixed-easing stop is rare and the
         values stay readable) */
      let timing = ''
      for (const lane of set.lanes.values()) {
        const kf = lane.find((k) => k.t === t)
        if (kf) {
          timing = easingCss(kf.easing, opts?.resolveEasing)
          break
        }
      }
      css.push(`  ${fmt(pct)}% { ${decls.join('; ')};${timing ? ` animation-timing-function: ${timing};` : ''} }`)
    }
    css.push(`}`)

    js.push(`// ${selector}`, `{`, `  const keyframes = [`)
    for (const t of times) {
      const decls = stopDecls(set.lanes, t, opts?.resolveEasing)
      const obj: Record<string, string> = { offset: fmt(t / dur) }
      for (const d of decls) {
        const i = d.indexOf(':')
        obj[d.slice(0, i).trim()] = d.slice(i + 1).trim()
      }
      const entries = Object.entries(obj)
        .map(([k, v]) => `${JSON.stringify(k)}: ${typeof v === 'string' && k !== 'offset' ? JSON.stringify(v) : v}`)
        .join(', ')
      js.push(`    { ${entries} },`)
    }
    js.push(
      `  ]`,
      `  document.querySelector(${JSON.stringify(selector)})?.animate(keyframes, { duration: DURATION, fill: 'both' })`,
      `}`,
      ``,
    )
  }

  /* ---- camera → the world wrapper ---- */
  const camera = comp.tracks.find((t) => t.kind === 'camera' && (t.keyframes?.length ?? 0) > 0)
  if (camera) {
    const lanes = keyframeLanes(camera.keyframes!)
    const times = [...new Set(camera.keyframes!.map((k) => k.t))].sort((a, b) => a - b)
    js.push(`// camera: the page's world wrapper carries this view transform`)
    js.push(`{`, `  const keyframes = [`)
    for (const t of times) {
      const state: Record<string, number | string> = {}
      for (const prop of CAMERA_PROPERTIES) {
        const lane = lanes.get(prop)
        if (lane?.length) state[prop] = laneValueAt(lane, t, opts?.resolveEasing)
      }
      const x = typeof state.x === 'number' ? state.x : 0
      const y = typeof state.y === 'number' ? state.y : 0
      const zoom = typeof state.zoom === 'number' ? state.zoom : 1
      const rotation = typeof state.rotation === 'number' ? state.rotation : 0
      js.push(
        `    { offset: ${fmt(t / dur)}, transform: 'translate(${fmt(-x)}px, ${fmt(-y)}px) scale(${fmt(zoom)}) rotate(${fmt(rotation)}deg)' },`,
      )
    }
    js.push(
      `  ]`,
      `  document.querySelector('[data-doop-world]')?.animate(keyframes, { duration: DURATION, fill: 'both' })`,
      `}`,
      ``,
    )
  }

  /* ---- transitions → a comment per pair ---- */
  const transitions = comp.tracks
    .filter((t) => t.kind === 'clip')
    .flatMap((t) => (t.clips ?? []).filter((c) => c.transition).map((c) => ({ track: t, clip: c })))
  if (transitions.length) {
    js.push(`/* transitions — pair the outgoing shot's window with the incoming one:`)
    for (const { clip } of transitions) {
      js.push(`   clip ${clip.id} @ ${fmt(clip.start)}s: ${transitionNote(clip)} */`)
    }
    js.push(``)
    notes.push(`${transitions.length} transition(s) emitted as WAAPI pairing notes — CSS has no two-clip composition`)
  }

  const files: MotionExportFile[] = [
    { name: 'composition.css', content: css.join('\n') + '\n' },
    { name: 'composition.js', content: js.join('\n') },
  ]
  if (targets.size === 0) notes.push('no animated elements — the export holds camera and transitions only')
  return { files, tokens, notes }
}
