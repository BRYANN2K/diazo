/**
 * shared/motionLayers.ts — element-layer planning (motion-elements P0).
 *
 * An element track whose pixels need compositor isolation — an effect
 * stack, a non-normal blend, a matte or masks, or `layer.mode:'on'` —
 * becomes a layer: the renderer rasterises the element alone into a
 * texture, runs its stack and blends it onto the frame buffer.
 * `planLayers` turns a composition into per-frame plans: which tracks
 * promote, whether the raster is static (transform/opacity-only lanes —
 * rendered once for the whole film) or dynamic (re-rastered when its
 * content changes), where the transform runs, the pad and texture scale,
 * and every budget issue (MO-15..19).
 *
 * Measured geometry — the element's border box, transform-origin, ink
 * overflow, paint order, clipping ancestors — comes from the browser
 * engine (P0-FE1's `__doopMotionPlan`). Without it the plan still decides
 * promotion, content and budgets that need no rect, and reports
 * `geometry: 'unavailable'`.
 */

import {
  LAYER_TRANSFORM_PROPS,
  MOTION_BLOCK_ATTR,
  MOTION_LIMITS,
  SCENE_ATTR,
  elementKey,
  motionNumber,
  parseMotionBlock,
  type Composition,
  type FrameMotionBlock,
  type MotionLintIssue,
  type MotionTrack,
} from './motion.ts'
import { effectCost, enabledEffects, layerPadReach } from './motionFx.ts'
import { elementHasId, elementHtml, elementIndex, subtreeContains } from './motionLint.ts'
import { keyframeLanes, laneValueAt, type CompositionStateAt } from './motionRuntime.ts'

/* ---- the plan types ---- */

/** a frame-space rect, px */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * What the browser measures about one layer element (P0-FE1 seam).
 * Everything is frame space, the element at rest (track transform off).
 */
export interface LayerGeometry {
  /** the element's border box at rest */
  rect: Rect
  /** transform-origin at rest; default the rect's centre */
  origin?: { x: number; y: number }
  /** ink overflow beyond the border box (box-shadow, outlines), px per side */
  ink?: { top: number; right: number; bottom: number; left: number }
  /** DOM paint order among the frame's layers, back→front (z-index aware) */
  paintOrder?: number
  /** an ancestor that clips the layer: frame-space rect + corner radius.
   *  `shape` names the clip's complexity — 'rect' (default) is a square or
   *  rounded rectangle the compositor can apply; 'complex' (a path, an
   *  SVG clip, multiple radii) keeps the transform in CSS so the clip
   *  stays exact */
  clip?: { rect: Rect; radius: number; shape?: 'rect' | 'complex' }
  /** an ancestor carries a rest rotation/skew — the transform must stay in CSS */
  ancestorRotated?: boolean
  /** non-layer content paints over this layer's rest box (MO-18) */
  covered?: boolean
  /** tracked ancestors contributing their matrices, outermost first */
  parents?: { elementId: string; origin: { x: number; y: number } }[]
}

export interface LayerPlan {
  trackId: string
  frameId: string
  elementId: string
  /** back→front composite order inside the frame */
  order: number
  /** 'static' rasters once for the whole render; 'dynamic' re-rasters when
   *  non-transform content changes (a non-transform lane, a scene frame,
   *  frame-block motion on the element or a non-layer descendant) */
  content: 'static' | 'dynamic'
  /** which lanes made it dynamic, for the report */
  contentReasons: string[]
  /** where the track transform runs: the compositor's own matrix, or CSS
   *  inside the raster when the DOM asks for it (MO-17) */
  transform: 'compositor' | 'css'
  transformReason?: string
  /** false keeps the layer out of the picture (matte/effect-input source) */
  visible: boolean
  /** px of padding around the box on every side — authoring + effect grow,
   *  clamped to MAX_LAYER_PAD */
  pad: number
  /** texture px per frame px */
  scale: number
  /** raster size in texture px — present only with measured geometry */
  texture?: { width: number; height: number }
  /** area-weighted effect cost (the share of the output the stack covers —
   *  unweighted when the rect is unmeasured) */
  cost: number
  /** 'measured' with geometry, 'unavailable' without — the static plan is
   *  honest about what it does not know */
  geometry: 'measured' | 'unavailable'
}

export interface FramePlan {
  frameId: string
  /** layers in composite order, back→front */
  layers: LayerPlan[]
  /** MO-15..19 findings for this frame */
  issues: MotionLintIssue[]
}

export interface PlanOptions {
  /** measured geometry per `frameId/elementId` — from the browser engine */
  geometry?: ReadonlyMap<string, LayerGeometry>
  /** output px per frame px (the render's oversampling); default 1 */
  outputScale?: number
  /** per-frame HTML for scene/descendant checks — required for exact
   *  planning; without it content falls back to lane analysis only */
  html?: ReadonlyMap<string, string>
}

/* ---- promotion ---- */

/**
 * Is this track an element layer? `layer.mode:'on'` forces it, `'off'`
 * keeps the element in the base raster even with a stack (the stack then
 * does not draw — the escape hatch). `'auto'`/unset promotes when the
 * track carries an enabled effect, a non-normal blend, a matte or masks.
 * A muted track draws nothing extra — its element stays in the base.
 */
export function isLayer(track: MotionTrack): boolean {
  if (track.kind !== 'element' || track.muted || !track.frameId || !track.elementId) return false
  const mode = track.layer?.mode
  if (mode === 'off') return false
  if (mode === 'on') return true
  return (
    enabledEffects(track).length > 0 ||
    (track.blend != null && track.blend !== 'normal') ||
    track.matte != null ||
    (track.masks?.length ?? 0) > 0
  )
}

/* ---- static/dynamic ---- */

const TRANSFORM_SET = new Set<string>(LAYER_TRANSFORM_PROPS)

/**
 * Property namespaces a lane may touch without re-rastering: the transform
 * set runs in the compositor matrix; `fx:` lanes drive effect params on the
 * GL pass; `mask:` lanes drive vector masks (P1). Everything else changes
 * the pixels the raster must re-draw.
 */
function laneIsStatic(property: string): boolean {
  return TRANSFORM_SET.has(property) || property.startsWith('fx:') || property.startsWith('mask:')
}

function frameIsScene(html: string | undefined): boolean {
  return html !== undefined && (html.includes(SCENE_ATTR) || html.includes('var(--t'))
}

const MOTION_SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi

/** the frame's parsed data-doop-motion block (frame-authored keyframes and
 *  text animators), or null when the frame carries none */
function motionBlockOf(html: string | undefined): FrameMotionBlock | null {
  if (html === undefined) return null
  for (const m of html.matchAll(MOTION_SCRIPT_RE)) {
    if (!(m[1] ?? '').includes(MOTION_BLOCK_ATTR)) continue
    const block = parseMotionBlock(m[2] ?? '')
    if (block) return block
  }
  return null
}

/* ---- scale planning ---- */

/** texture px per frame px: the worst camera zoom times the layer's own
 *  scale reach, times the output ratio — snapped up to half steps and
 *  capped at 4 (a `layer.scale` override wins) */
function planScale(comp: Composition, track: MotionTrack, outputScale: number): number {
  if (track.layer?.scale !== undefined) return track.layer.scale
  let maxZoom = 1
  for (const kf of comp.tracks.find((t) => t.kind === 'camera')?.keyframes ?? []) {
    if (kf.property === 'zoom' && typeof kf.value === 'number') maxZoom = Math.max(maxZoom, kf.value)
  }
  let maxTrackScale = 1
  for (const kf of track.keyframes ?? []) {
    if (
      (kf.property === 'scale' || kf.property === 'scaleX' || kf.property === 'scaleY') &&
      typeof kf.value === 'number'
    ) {
      maxTrackScale = Math.max(maxTrackScale, Math.abs(kf.value))
    }
  }
  const need = maxZoom * maxTrackScale * outputScale
  return Math.min(4, Math.ceil(need * 2) / 2)
}

/* ---- the planner ---- */

/**
 * Plan every frame's layers. `frames` names the frames on the page (ids,
 * plus optional html for scene and nesting checks). Returns FramePlans in
 * page order — a frame with no layers still appears, with an empty list.
 */
export function planLayers(
  comp: Composition,
  frames: readonly { id: string; html?: string }[],
  opts?: PlanOptions,
): FramePlan[] {
  const htmlOf = (frameId: string): string | undefined =>
    opts?.html?.get(frameId) ?? frames.find((f) => f.id === frameId)?.html
  const plans: FramePlan[] = []
  let filmLayers = 0
  let filmBytes = 0
  const filmArea = comp.width * comp.height

  /* matte references resolve in composition context: an element track a
     matte names as its source must promote too — its texture has to exist
     for the borrow — while a dangling, muted or cross-frame source is
     MO-16, and a matte chain that cycles is refused the same way */
  const matteSource = new Map<string, MotionTrack | 'dangle' | 'cycle'>()
  for (const track of comp.tracks) {
    if (!track.matte) continue
    const seen = new Set([track.id])
    let cur: string | undefined = track.matte.source
    let cyclic = false
    while (cur !== undefined) {
      if (seen.has(cur)) {
        cyclic = true
        break
      }
      seen.add(cur)
      cur = comp.tracks.find((t) => t.id === cur)?.matte?.source
    }
    matteSource.set(track.id, cyclic ? 'cycle' : (comp.tracks.find((t) => t.id === track.matte!.source) ?? 'dangle'))
  }

  /* candidates: promoted tracks plus the element tracks a matte borrows
     from. A matte source that draws no texture of its own (muted, or
     layer.mode:'off') cannot feed a matte — the consumer gets MO-16. */
  const promoted = comp.tracks.filter(isLayer)
  const candidateIds = new Set(promoted.map((t) => t.id))
  for (const track of promoted) {
    const source = track.matte ? matteSource.get(track.id) : undefined
    if (source && source !== 'dangle' && source !== 'cycle' && !candidateIds.has(source.id)) {
      if (!source.muted && source.layer?.mode !== 'off' && source.frameId === track.frameId) {
        candidateIds.add(source.id)
      }
    }
  }
  const layersByFrame = new Map<string, MotionTrack[]>()
  for (const track of comp.tracks) {
    if (!candidateIds.has(track.id) || !track.frameId) continue
    const list = layersByFrame.get(track.frameId) ?? []
    list.push(track)
    layersByFrame.set(track.frameId, list)
  }

  for (const frame of frames) {
    const issues: MotionLintIssue[] = []
    const push = (rule: string, severity: MotionLintIssue['severity'], message: string) =>
      issues.push({ rule, severity, message, frameId: frame.id })
    const html = htmlOf(frame.id)
    const candidates = layersByFrame.get(frame.id) ?? []

    for (const track of candidates) {
      if (!track.matte) continue
      const source = matteSource.get(track.id)
      const elementId = track.elementId!
      if (source === 'cycle') {
        push('MO-16', 'error', `layer ${elementId}'s matte chain cycles — a matte cannot borrow itself`)
      } else if (source === 'dangle' || source === undefined) {
        push('MO-16', 'error', `layer ${elementId}'s matte → ${track.matte.source} points at no track`)
      } else if (source.kind !== 'element' || source.frameId !== frame.id) {
        push('MO-16', 'error', `layer ${elementId}'s matte → ${track.matte.source} is not an element of this frame`)
      } else if (source.muted || source.layer?.mode === 'off') {
        push(
          'MO-16',
          'warning',
          `matte source ${source.elementId} draws no texture — layer ${elementId}'s matte has nothing to borrow`,
        )
      }
    }

    /* a candidate nested inside an effect-carrying one would get the
       parent's stack baked into its raster and applied again. P0 keeps
       the child inside the parent's layer — it is absorbed rather than
       promoted — and its own lanes count toward the parent's dynamic
       content (MO-19 reports it) */
    const absorbed = new Set<MotionTrack>()
    for (const child of candidates) {
      for (const parent of candidates) {
        if (parent === child || enabledEffects(parent).length === 0) continue
        if (subtreeContains(html, parent.elementId!, child.elementId!)) {
          absorbed.add(child)
          push(
            'MO-19',
            'error',
            `layer ${child.elementId} nests inside effect-carrying layer ${parent.elementId} — it draws inside the parent's raster and its own stack does not composite; move the effects to the child or unnest`,
          )
          break
        }
      }
    }
    const layerTracks = candidates.filter((t) => !absorbed.has(t))
    const layerElementIds = new Set(layerTracks.map((t) => t.elementId!))

    if (layerTracks.length > MOTION_LIMITS.MAX_LAYERS_PER_FRAME) {
      push(
        'MO-15',
        'error',
        `frame has ${layerTracks.length} layers — over the ${MOTION_LIMITS.MAX_LAYERS_PER_FRAME} per-frame budget`,
      )
    }

    const block = motionBlockOf(html)
    const layers: LayerPlan[] = []
    for (const track of layerTracks) {
      const elementId = track.elementId!

      /* where the transform runs — decided first: with transform 'css'
         the transform/opacity lanes live inside the raster and re-paint
         it, so content is classified after placement */
      let transform = track.layer?.transform ?? 'compositor'
      let transformReason: string | undefined
      if (track.layer?.transform === undefined) {
        const geo = opts?.geometry?.get(elementKey(frame.id, elementId))
        if (geo?.ancestorRotated) {
          transform = 'css'
          transformReason = 'an ancestor carries a rest rotation or skew'
        } else if (geo?.clip && !clipIsPlainRect(geo.clip)) {
          transform = 'css'
          transformReason = 'a clipping ancestor is not a plain rect'
        }
        if (transform === 'css' && transformReason) {
          push('MO-17', 'warning', `layer ${elementId}: transform falls back to CSS — ${transformReason}`)
        }
      }
      const geo = opts?.geometry?.get(elementKey(frame.id, elementId))

      /* content: static unless a lane, a scene frame, frame-block motion,
         a text animator or a non-layer tracked descendant re-paints the
         pixels — a cached texture must never freeze any of them */
      const reasons: string[] = []
      const lanes = keyframeLanes(track.keyframes ?? [])
      for (const prop of lanes.keys()) {
        if (TRANSFORM_SET.has(prop)) {
          if (transform === 'css') reasons.push(`lane ${prop} stays inside the raster (transform: css)`)
          continue
        }
        if (!laneIsStatic(prop)) reasons.push(`lane ${prop} repaints`)
      }
      if (frameIsScene(html)) reasons.push('the frame is a scene')
      if (block) {
        const subtree = html ? elementHtml(html, elementId) : null
        if (block.keyframes.some((k) => k.el === elementId || (subtree !== null && elementHasId(subtree, k.el)))) {
          reasons.push('frame-block motion touches the element')
        }
        for (const animator of block.animators ?? []) {
          if (animator.el === elementId || (subtree !== null && elementHasId(subtree, animator.el))) {
            reasons.push(`a text animator drives ${animator.el}`)
            break
          }
        }
      }
      for (const other of comp.tracks) {
        if (other === track || other.kind !== 'element' || other.frameId !== frame.id || !other.elementId) continue
        if (layerElementIds.has(other.elementId)) continue
        if ((other.keyframes ?? []).length === 0) continue
        if (subtreeContains(html, elementId, other.elementId)) {
          reasons.push(`tracked descendant ${other.elementId} is not a layer`)
        }
      }
      const content = reasons.length > 0 ? 'dynamic' : 'static'

      /* the pad the stack honestly asks for, unclamped — authoring pad on
         top of the registry-default-aware, lane-aware grow. Over the cap
         is an MO-15 the render refuses on, not a silent crop */
      const reach = (track.layer?.pad ?? 0) + layerPadReach(track)
      if (reach > MOTION_LIMITS.MAX_LAYER_PAD) {
        push(
          'MO-15',
          'error',
          `layer ${elementId} needs ${Math.ceil(reach)}px of padding — over the ${MOTION_LIMITS.MAX_LAYER_PAD}px pad budget`,
        )
      }
      const pad = Math.min(MOTION_LIMITS.MAX_LAYER_PAD, reach)
      const scale = planScale(comp, track, opts?.outputScale ?? 1)

      let texture: LayerPlan['texture']
      if (geo) {
        const ink = geo.ink ?? { top: 0, right: 0, bottom: 0, left: 0 }
        const w = Math.ceil((geo.rect.width + pad + ink.left + ink.right + pad) * scale)
        const h = Math.ceil((geo.rect.height + pad + ink.top + ink.bottom + pad) * scale)
        texture = { width: w, height: h }
        if (w > MOTION_LIMITS.MAX_LAYER_SIDE || h > MOTION_LIMITS.MAX_LAYER_SIDE) {
          push(
            'MO-15',
            'error',
            `layer ${elementId} needs a ${w}×${h} texture — over the ${MOTION_LIMITS.MAX_LAYER_SIDE}px side budget`,
          )
        }
        filmBytes += w * h * 4
      }
      filmLayers += 1
      if (geo?.covered) {
        push('MO-18', 'warning', `non-layer content paints over layer ${elementId}'s box — promote it or reorder`)
      }

      layers.push({
        trackId: track.id,
        frameId: frame.id,
        elementId,
        order: 0,
        content,
        contentReasons: reasons,
        transform,
        ...(transformReason ? { transformReason } : {}),
        visible: track.layer?.visible !== false,
        pad,
        scale,
        ...(texture ? { texture } : {}),
        cost: effectCost(track, geo ? (geo.rect.width * geo.rect.height) / filmArea : 1),
        geometry: geo ? 'measured' : 'unavailable',
      })
    }

    /* composite order: measured paint order wins, else document order in
       the frame's markup (ordinary-flow approximation) — the array is
       returned sorted and `order` is assigned after the sort */
    const docIndex = (elementId: string): number => {
      if (html === undefined) return 0
      const i = elementIndex(html, elementId)
      return i < 0 ? Number.MAX_SAFE_INTEGER : i
    }
    const ordered = layers
      .map((layer) => ({
        layer,
        key: opts?.geometry?.get(elementKey(layer.frameId, layer.elementId))?.paintOrder ?? docIndex(layer.elementId),
      }))
      .sort((a, b) => a.key - b.key)
    ordered.forEach((entry, i) => {
      entry.layer.order = i
    })

    plans.push({ frameId: frame.id, layers: ordered.map((e) => e.layer), issues })
  }

  if (filmLayers > MOTION_LIMITS.MAX_LAYERS) {
    plans[0]?.issues.push({
      rule: 'MO-15',
      severity: 'error',
      message: `${filmLayers} layers across the film — over the ${MOTION_LIMITS.MAX_LAYERS} budget`,
    })
  }
  if (filmBytes > MOTION_LIMITS.MAX_LAYER_TEXTURE_BYTES) {
    const mb = Math.ceil(filmBytes / (1024 * 1024))
    plans[0]?.issues.push({
      rule: 'MO-15',
      severity: 'error',
      message: `layer textures need ~${mb} MB — over the ${MOTION_LIMITS.MAX_LAYER_TEXTURE_BYTES / (1024 * 1024)} MB budget`,
    })
  }
  return plans
}

/**
 * The film's effect bill the way the renderer pays it: the scene stacks
 * (camera and adjustment) plus the element stacks whose track promotes to
 * a drawable layer. Muted tracks, `layer.mode:'off'` escapes and
 * invisible layers raster nothing and cost nothing — a suppressed element
 * stack must not sink a render under the cap. `plans` reuses a caller's
 * layer plan; the caller passes every frame's plan.
 */
export function sceneEffectBill(comp: Composition, plans: readonly FramePlan[]): number {
  const drawable = new Set<string>()
  for (const plan of plans) {
    for (const layer of plan.layers) if (layer.visible) drawable.add(layer.trackId)
  }
  let bill = 0
  for (const track of comp.tracks) {
    if (track.muted) continue
    if (track.kind === 'element' && !drawable.has(track.id)) continue
    bill += effectCost(track)
  }
  return bill
}

/** a clip counts as plain when the compositor can apply it — a square or
 *  rounded rect. A path, an SVG clip or per-corner radii is 'complex' and
 *  keeps the transform in CSS so the clip stays exact */
function clipIsPlainRect(clip: NonNullable<LayerGeometry['clip']>): boolean {
  return (clip.shape ?? 'rect') === 'rect'
}

/* ---- the transform matrix ---- */

/** column-major 2D affine [a, b, c, d, e, f]: (x, y) → (a·x + c·y + e, b·x + d·y + f) */
export type Affine2D = readonly [number, number, number, number, number, number]

const translate = (x: number, y: number): Affine2D => [1, 0, 0, 1, x, y]
const rotate = (deg: number): Affine2D => {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  return [c, s, -s, c, 0, 0]
}
const scaleM = (sx: number, sy: number): Affine2D => [sx, 0, 0, sy, 0, 0]
const skew = (kxDeg: number, kyDeg: number): Affine2D => [
  1,
  Math.tan((kyDeg * Math.PI) / 180),
  Math.tan((kxDeg * Math.PI) / 180),
  1,
  0,
  0,
]

/** m1 ∘ m2 — m2 applies to the point first */
export function mulAffine(m1: Affine2D, m2: Affine2D): Affine2D {
  const [a1, b1, c1, d1, e1, f1] = m1
  const [a2, b2, c2, d2, e2, f2] = m2
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ]
}

const numProp = (props: Record<string, number | string> | undefined, name: string): number | undefined =>
  motionNumber(props?.[name])

/**
 * One element's local matrix about its origin: the track transform the way
 * elementCss writes it — translate, then rotate, then scale, then skew —
 * applied around the measured transform-origin O:
 *
 *   M = T(O) · T(x,y) · R(rotate) · S(sx,sy) · K(skewX,skewY) · T(−O)
 */
function localMatrix(props: Record<string, number | string> | undefined, origin: { x: number; y: number }): Affine2D {
  const x = numProp(props, 'x') ?? 0
  const y = numProp(props, 'y') ?? 0
  const s = numProp(props, 'scale')
  const sx = numProp(props, 'scaleX') ?? s ?? 1
  const sy = numProp(props, 'scaleY') ?? s ?? 1
  const rot = numProp(props, 'rotate') ?? 0
  const kx = numProp(props, 'skewX') ?? 0
  const ky = numProp(props, 'skewY') ?? 0
  let m: Affine2D = translate(origin.x, origin.y)
  m = mulAffine(m, translate(x, y))
  m = mulAffine(m, rotate(rot))
  m = mulAffine(m, scaleM(sx, sy))
  m = mulAffine(m, skew(kx, ky))
  m = mulAffine(m, translate(-origin.x, -origin.y))
  return m
}

/**
 * The layer's compositor matrix at `state`: the element's local transform
 * about its measured origin, premultiplied by every tracked ancestor's
 * local matrix (outermost first, per `geometry.parents`). Without measured
 * geometry the origin is (0,0) — translation still resolves exactly.
 */
export function layerMatrix(plan: LayerPlan, state: CompositionStateAt, geometry?: LayerGeometry): Affine2D {
  const geo = geometry
  const elementOrigin =
    geo?.origin ??
    (geo?.rect ? { x: geo.rect.x + geo.rect.width / 2, y: geo.rect.y + geo.rect.height / 2 } : { x: 0, y: 0 })
  let m = localMatrix(state.elements[elementKey(plan.frameId, plan.elementId)], elementOrigin)
  /* parents arrive outermost-first; the innermost matrix premultiplies
     first so the composed order is outer · … · inner · local — an outer
     scale multiplies an inner translation, not the other way round */
  for (const parent of [...(geo?.parents ?? [])].reverse()) {
    const parentM = localMatrix(state.elements[elementKey(plan.frameId, parent.elementId)], parent.origin)
    m = mulAffine(parentM, m)
  }
  return m
}

/* ---- raster CSS ----
 * The two sheets the foreignObject rasteriser needs: one that isolates the
 * layer element on a transparent page (everything else visibility:hidden),
 * and one that hides the promoted elements out of the base raster. */

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/

const safeId = (id: string): string => {
  if (!ID_RE.test(id)) throw new Error(`unsafe element id ${id}`)
  return id
}

/** stylesheet for the isolated-layer raster: only the element's subtree
 *  paints, on a transparent page. `hiddenIds` are nested layer elements to
 *  keep out of this raster too (they composite on their own). */
export function layerIsolateCss(elementId: string, hiddenIds: readonly string[] = []): string {
  const el = safeId(elementId)
  const hidden = hiddenIds.map(safeId)
  return (
    `html, body { background: transparent !important; }\n` +
    `* { visibility: hidden !important; }\n` +
    `[data-doop-id="${el}"], [data-doop-id="${el}"] * { visibility: visible !important; }` +
    (hidden.length > 0
      ? `\n${hidden.map((id) => `[data-doop-id="${id}"], [data-doop-id="${id}"] * { visibility: hidden !important; }`).join('\n')}`
      : '')
  )
}

/** stylesheet for the base raster: the promoted elements and their whole
 *  subtrees vanish — their pixels come back through the compositor */
export function baseHideCss(elementIds: readonly string[]): string {
  return elementIds
    .map((id) => `[data-doop-id="${safeId(id)}"], [data-doop-id="${safeId(id)}"] * { visibility: hidden !important; }`)
    .join('\n')
}

/**
 * Which resolved element properties still belong in the raster's CSS at t:
 * with `transform: 'compositor'` the track transform runs in the
 * compositor's matrix, so the raster drops the transform/opacity props and
 * keeps everything else (filters, colours, …); with 'css' the raster keeps
 * the whole resolved state.
 */
export function layerRasterProps(
  transform: 'compositor' | 'css',
  props: Record<string, number | string>,
): Record<string, number | string> {
  if (transform === 'css') return props
  const out: Record<string, number | string> = {}
  for (const [key, value] of Object.entries(props)) {
    if (!TRANSFORM_SET.has(key)) out[key] = value
  }
  return out
}

/** lane values of one track at t — the props record layerMatrix and
 *  layerRasterProps consume */
export function layerPropsAt(track: MotionTrack, t: number): Record<string, number | string> {
  const props: Record<string, number | string> = {}
  for (const [prop, lane] of keyframeLanes(track.keyframes ?? [])) {
    props[prop] = laneValueAt(lane, t)
  }
  return props
}
