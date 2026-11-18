/**
 * shared/motion.ts — the Motion Studio ("Rostrum") contract.
 *
 * A composition hangs off an ordinary canvas page: the page's frames are the
 * stage, the composition is the clock over them. Everything here is shared
 * between the timeline editor, the player, the MCP tools and the renderers,
 * and everything is deterministic — the same composition plus the same time
 * always produces the same state, which is what seeking, multiplayer edits
 * and frame-accurate renders are built on.
 *
 * Wire stability: the frontend codes against this file. Additive changes
 * only; anything else goes in docs/motion-api.md "Changes".
 */

import { nanoid } from 'nanoid'
import { effectSpec } from './motionFx.ts'

export const MOTION_SCHEMA_VERSION = 1

/* ---- seek-safe markup contract (adopted from HyperFrames, Apache-2.0) ----
 * A scene is a frame document on the composition's page that opts in with
 * `data-doop-scene` on its root; the root carries `data-duration` (seconds),
 * `data-fps`, `data-width`, `data-height`. Timed elements inside carry
 * `data-start` (seconds) and `data-duration`; they are visible over
 * [start, start + duration). Media clips may add `data-media-start` (trim)
 * and `data-volume`. Lanes in markup carry `data-doop-track` with
 * `data-doop-track-kind` naming the lane. Per-frame keyframe data lives in
 * `<script type="application/json" data-doop-motion">`. The runtime writes
 * `--t` on the scene root and dispatches `doop:seek` at every seek; scripts
 * listen to that event instead of running their own clocks. */

export const SCENE_ATTR = 'data-doop-scene'
export const DURATION_ATTR = 'data-duration'
export const FPS_ATTR = 'data-fps'
export const WIDTH_ATTR = 'data-width'
export const HEIGHT_ATTR = 'data-height'
export const START_ATTR = 'data-start'
export const MEDIA_START_ATTR = 'data-media-start'
export const TRACK_INDEX_ATTR = 'data-track-index'
export const VOLUME_ATTR = 'data-volume'
export const HIDDEN_ATTR = 'data-hidden'

export const MOTION_BLOCK_ATTR = 'data-doop-motion'
export const MOTION_BLOCK_TYPE = 'application/json'

export const TRACK_ATTR = 'data-doop-track'
export const TRACK_KIND_ATTR = 'data-doop-track-kind'
export const MARKUP_TRACK_KINDS = ['graphics', 'captions', 'video', 'audio', '3d'] as const
export type MarkupTrackKind = (typeof MARKUP_TRACK_KINDS)[number]

export const TIME_CSS_VAR = '--t'
export const SEEK_EVENT = 'doop:seek'

/** text animator: the element carries this attr naming its split mode; the
 *  player derives units at runtime while the HTML keeps one editable string */
export const TEXT_SPLIT_ATTR = 'data-doop-split'
export const TEXT_SPLITS = ['line', 'word', 'char'] as const
export type TextSplit = (typeof TEXT_SPLITS)[number]

/** one transcribed word on the media's own clock; `speaker` names an `S*`
 *  label when speaker labels ran (proposal 18.8) */
export interface TranscriptWord {
  text: string
  /** seconds in source media time */
  start: number
  end: number
  confidence?: number
  speaker?: string
}

/** scroll/pointer-driven layers (phase 4): a 3d or timed subtree can name a
 *  driver other than the composition clock */
export const DRIVER_ATTR = 'data-doop-driver'
export const DRIVERS = ['time', 'scroll', 'pointer'] as const
export type MotionDriver = (typeof DRIVERS)[number]

/** prefixes a frame's custom properties use for motion tokens */
export const MOTION_TOKEN_PREFIXES = ['--dur-', '--ease-', '--spring-'] as const

/* ---- limits ---- */

export const MOTION_LIMITS = {
  MIN_DURATION_S: 0.1,
  MAX_DURATION_S: 600,
  MIN_FPS: 1,
  MAX_FPS: 120,
  MIN_SIZE: 16,
  MAX_SIZE: 8192,
  MAX_TRACKS: 64,
  MAX_KEYFRAMES_PER_TRACK: 2000,
  MAX_CLIPS_PER_TRACK: 400,
  MAX_CAPTION_TEXT: 2000,
  MAX_VALUE_TEXT: 4000,
  MAX_NAME: 80,
  /** render uploads go through storeAsset like other assets but video files
   *  are bigger than images, so the route applies this cap */
  RENDER_MAX_BYTES: 250 * 1024 * 1024,
  /** at most this many non-finished jobs per canvas */
  MAX_ACTIVE_JOBS: 3,
  /* element-layer budgets (motion-elements P0): promoted element tracks
     isolate their pixels into textures — these caps keep the layer pool
     bounded so the compositor's memory and pass counts stay predictable.
     Breaching them is lint MO-15 and a refused render. */
  MAX_LAYERS_PER_FRAME: 24,
  MAX_LAYERS: 64,
  /** one layer texture side, px (premultiplied RGBA8) */
  MAX_LAYER_SIDE: 4096,
  /** the whole film's layer textures, bytes */
  MAX_LAYER_TEXTURE_BYTES: 256 * 1024 * 1024,
  /** pixels an effect stack may grow a layer past its border box */
  MAX_LAYER_PAD: 512,
} as const

/** nanoid-shaped ids — client, server and agent ops all mint these */
export const MOTION_ID_RE = /^[A-Za-z0-9_-]{1,100}$/

export const newMotionId = (): string => nanoid()

/* ---- easing ---- */

/**
 * How the segment leaving a keyframe interpolates. `hold` keeps the
 * keyframe's value until the next key (a cut). `token` names a canvas motion
 * token (`--ease-*`, `--spring-*`); callers resolve it to a concrete curve
 * and unresolved tokens fall back to linear so output stays deterministic.
 */
export type MotionEasing =
  | { type: 'linear' }
  | { type: 'hold' }
  | { type: 'steps'; steps: number; position?: 'start' | 'end' }
  | { type: 'cubic-bezier'; x1: number; y1: number; x2: number; y2: number }
  | { type: 'spring'; stiffness: number; damping: number; mass: number }
  | { type: 'token'; name: string }

/** the CSS named easings, as canonical cubic-beziers */
export const NAMED_EASINGS: Record<string, MotionEasing> = {
  linear: { type: 'linear' },
  ease: { type: 'cubic-bezier', x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 },
  'ease-in': { type: 'cubic-bezier', x1: 0.42, y1: 0, x2: 1, y2: 1 },
  'ease-out': { type: 'cubic-bezier', x1: 0, y1: 0, x2: 0.58, y2: 1 },
  'ease-in-out': { type: 'cubic-bezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
  hold: { type: 'hold' },
  'step-start': { type: 'steps', steps: 1, position: 'start' },
  'step-end': { type: 'steps', steps: 1, position: 'end' },
}

/**
 * Parse a wire easing: the object form above, or one of the CSS names in
 * NAMED_EASINGS. Returns null on anything else.
 */
export function parseEasing(input: unknown): MotionEasing | null {
  if (typeof input === 'string') return NAMED_EASINGS[input] ?? null
  if (!isRecord(input)) return null
  const type = input.type
  if (type === 'linear' || type === 'hold') return { type }
  if (type === 'steps') {
    const steps = input.steps
    const position = input.position
    if (!Number.isInteger(steps) || (steps as number) < 1 || (steps as number) > 1000) return null
    if (position !== undefined && position !== 'start' && position !== 'end') return null
    return { type, steps: steps as number, position: position as 'start' | 'end' | undefined }
  }
  if (type === 'cubic-bezier') {
    const { x1, y1, x2, y2 } = input
    if (![x1, y1, x2, y2].every((v) => typeof v === 'number' && Number.isFinite(v))) return null
    /* x must stay inside [0,1] for the curve to stay a function; y may
       overshoot (that's what makes it bouncy) */
    if ((x1 as number) < 0 || (x1 as number) > 1 || (x2 as number) < 0 || (x2 as number) > 1) return null
    return { type, x1: x1 as number, y1: y1 as number, x2: x2 as number, y2: y2 as number }
  }
  if (type === 'spring') {
    const { stiffness, damping, mass } = input
    if (
      typeof stiffness !== 'number' ||
      typeof damping !== 'number' ||
      typeof mass !== 'number' ||
      !(stiffness > 0) ||
      !(damping >= 0) ||
      !(mass > 0)
    ) {
      return null
    }
    return { type, stiffness, damping, mass }
  }
  if (type === 'token') {
    const name = input.name
    if (typeof name !== 'string' || name.length < 1 || name.length > 100) return null
    return { type, name }
  }
  return null
}

/**
 * Parse a motion token's CSS text — `cubic-bezier(…)`, `spring(k, d, m)`,
 * `steps(n[, pos])`, or a named easing — into a MotionEasing. This is what a
 * `--ease-*`/`--spring-*` custom property's value resolves to.
 */
export function parseEasingToken(value: string): MotionEasing | null {
  const v = value.trim()
  const named = NAMED_EASINGS[v]
  if (named) return named
  let m = /^cubic-bezier\(\s*([^,)]+)\s*,\s*([^,)]+)\s*,\s*([^,)]+)\s*,\s*([^)]+)\s*\)$/i.exec(v)
  if (m) {
    return parseEasing({ type: 'cubic-bezier', x1: +m[1]!, y1: +m[2]!, x2: +m[3]!, y2: +m[4]! })
  }
  m = /^spring\(\s*([^,)]+)\s*,\s*([^,)]+)\s*,\s*([^)]+)\s*\)$/i.exec(v)
  if (m) {
    return parseEasing({ type: 'spring', stiffness: +m[1]!, damping: +m[2]!, mass: +m[3]! })
  }
  m = /^steps\(\s*(\d+)\s*(?:,\s*(start|end)\s*)?\)$/i.exec(v)
  if (m) {
    return parseEasing({ type: 'steps', steps: +m[1]!, position: m[2] as 'start' | 'end' | undefined })
  }
  return null
}

/* ---- keyframes, clips, tracks ---- */

/**
 * Camera keyframe properties: the rect of page world the output shows.
 * `x`/`y` are world coords of the view's centre, `zoom` is output px per
 * world px, `rotation` is degrees clockwise. They only live on the camera
 * track.
 */
export const CAMERA_PROPERTIES = ['x', 'y', 'zoom', 'rotation'] as const
export type CameraProperty = (typeof CAMERA_PROPERTIES)[number]

export function isCameraProperty(v: unknown): v is CameraProperty {
  return typeof v === 'string' && (CAMERA_PROPERTIES as readonly string[]).includes(v)
}

/**
 * Properties element tracks animate — what the editor offers. The runtime
 * interpolates any pair of numbers and any pair of colors; other string
 * values flip discretely (CSS behaviour). Custom properties (`--*`) are
 * allowed and always discrete.
 */
export const ELEMENT_PROPERTIES = [
  'x',
  'y',
  'scale',
  'scaleX',
  'scaleY',
  'rotate',
  'skewX',
  'skewY',
  'opacity',
  'blur',
  'brightness',
  'contrast',
  'saturate',
  'grayscale',
  'hue-rotate',
  'borderRadius',
  'color',
  'backgroundColor',
  /* masks, shapes and paths (proposal 14.6): clip-path forms, trim-path
     dash pairs, morphing `d`, motion-path offset-* and paint colours */
  'clipPath',
  'offsetPath',
  'offsetDistance',
  'offsetRotate',
  'strokeDashoffset',
  'strokeDasharray',
  'd',
  'fill',
  'stroke',
] as const

const PROPERTY_RE = /^(--)?[A-Za-z][A-Za-z0-9-]{0,59}$/
/** effect-param lanes: `fx:<instanceId>.<param>` — e.g. `fx:g1.intensity` */
const FX_PROPERTY_RE = /^fx:[A-Za-z0-9_-]{1,100}\.[A-Za-z][A-Za-z0-9-]{0,59}$/

export function isFxProperty(v: unknown): v is string {
  return typeof v === 'string' && FX_PROPERTY_RE.test(v)
}

/** the `{instanceId, param}` an `fx:` property names */
export function fxPropertyParts(property: string): { effectId: string; param: string } | null {
  const m = /^fx:([A-Za-z0-9_-]{1,100})\.([A-Za-z][A-Za-z0-9-]{0,59})$/.exec(property)
  return m ? { effectId: m[1]!, param: m[2]! } : null
}

export interface MotionKeyframe {
  id: string
  /** `x`/`y`/`zoom`/`rotation` on the camera track; an animatable property on
   *  an element track; `gain` on an audio track */
  property: string
  /** seconds on the composition clock, [0, duration] */
  t: number
  value: number | string
  /** interpolation of the segment that leaves this keyframe */
  easing: MotionEasing
  /** the preset id that authored this keyframe, when one did. `clipPath`
   *  lanes render only while preset-authored: the parser has accepted the
   *  property since before it drew, so an unmarked lane is a stored legacy
   *  lane and must stay raster-inert */
  preset?: string
}

/** what a clip shows or plays while it is on screen */
export type MotionClipSource =
  /** a frame of the composition's page, as a shot */
  | { type: 'frame'; frameId: string }
  /** a canvas library item (a reusable design/Motion element) */
  | { type: 'library'; itemId: string; variantId?: string }
  /** an /a/ asset: uploaded or generated media (video, audio, image) */
  | { type: 'asset'; assetId: string }
  /** caption text drawn by the caption lane; `style` names an editor preset.
   *  `words` carries per-word timings so word-highlight styles can light the
   *  current word — written by build_captions from a transcript */
  | { type: 'caption'; text: string; style?: string; words?: TranscriptWord[] }
  /** an adjustment window: no pixels of its own, the track's effect stack
   *  applies to the layers below over [start, start+duration) */
  | { type: 'adjustment' }
  /** a 3D layer (phase 4): `assetId` is a glTF/GLB canvas asset rendered by a
   *  three.js layer in the frame; `fallbackAssetId` is the still image a
   *  non-3D surface (export, thumbnail, old shell) draws instead. `driver`
   *  overrides the composition clock — `scroll`/`pointer` let the layer scrub
   *  on page input even inside a timed composition (default 'time') */
  | { type: '3d'; assetId: string; fallbackAssetId?: string; driver?: MotionDriver }

/* ---- transitions (proposal 14.4) ----
 * A transition is the overlap of two visibility windows plus one paired
 * animation. It hangs on the incoming clip: when the clip takes over from
 * the previous clip on the same track, `transition` says how. `cut` is the
 * default — no transition, the field is simply absent. */

export const TRANSITION_KINDS = ['cut', 'dissolve', 'push', 'wipe', 'zoom', 'shared-element'] as const
export type TransitionKind = (typeof TRANSITION_KINDS)[number]

export const TRANSITION_DIRECTIONS = ['left', 'right', 'up', 'down'] as const
export type TransitionDirection = (typeof TRANSITION_DIRECTIONS)[number]

export interface MotionTransition {
  kind: TransitionKind
  /** seconds the two clips' windows overlap */
  duration: number
  /** the `--dur-*` token the duration came from — kept so a token change can
   *  retime it; `duration` stays the resolved fallback for renderers */
  token?: string
  /** push/wipe travel direction; default left for push, right for wipe */
  direction?: TransitionDirection
  /** interpolation of the paired animation; default is per-kind */
  easing?: MotionEasing
}

export interface MotionClip {
  id: string
  /** seconds on the composition clock; visible over [start, start+duration) */
  start: number
  duration: number
  source: MotionClipSource
  name?: string
  /** trim: seconds into the source media the clip opens at (video/audio) */
  mediaStart?: number
  /** playback rate of the media inside this clip, 0.25× to 4×; 1 when absent.
   *  One value per clip — a speed ramp is several clips (proposal 14.10) */
  speed?: number
  /** audio level, 1 = 0 dB */
  gain?: number
  /** seconds the audio fades in/out inside this clip's window (audio clips) */
  fadeIn?: number
  fadeOut?: number
  muted?: boolean
  /** how this clip takes over from the previous clip on the same track;
   *  absent = a hard cut */
  transition?: MotionTransition
}

/* ---- effects (motion-pro P1) ----
 * An effect stack hangs on a track: element tracks grade their element,
 * clip tracks their clips, the camera track the whole scene, and an
 * `adjustment` track everything below it over its clip windows. Params are
 * keyframable through the `fx:<instanceId>.<param>` property namespace, so
 * an intensity can ease like any other number. Every effect ships seeded —
 * pixels stay a pure function of (composition, t). */

/* the 26 colour blend modes of the compositor (motion-elements P0): the 20
 * separable modes first, then the 6 non-separable ones. Order is the mode
 * index BLEND_GLSL and the CPU reference in shared/motionBlend.ts share —
 * append-only, never reorder. Existing spellings are kept. */
export const BLEND_MODES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'add',
  'subtract',
  'divide',
  'linear-burn',
  'vivid-light',
  'linear-light',
  'pin-light',
  'hard-mix',
  'hue',
  'saturation',
  'color',
  'luminosity',
  'darker-color',
  'lighter-color',
] as const
export type BlendMode = (typeof BLEND_MODES)[number]

/** one effect on a track's stack — registry shapes are in shared/motionFx.ts */
export interface EffectInstance {
  /** stable id — keyframes address params as `fx:<id>.<param>` */
  id: string
  /** registry id: 'gaussian-blur', 'glow', 'film-grain', … */
  fx: string
  enabled?: boolean
  /** resting values; fx: keyframes override them at render time */
  params: Record<string, number | string | boolean>
  /** deterministic noise/particles; defaults to a hash of `id` */
  seed?: number
  /** wet/dry, default 1 */
  mix?: number
  blend?: BlendMode
}

/* ---- element layers (motion-elements P0) ----
 * An element track whose pixels need compositor isolation — an effect stack,
 * a non-normal blend, a matte or masks, or an explicit `layer.mode:'on'` —
 * becomes a layer: the renderer rasterises the element alone into a texture,
 * runs its stack and blends it onto the frame buffer. `LayerSpec` is the
 * authoring contract; shared/motionLayers.ts turns it into a plan. */

/** element-track properties the compositor's own matrix handles — everything
 *  else a lane touches makes the layer's raster dynamic (shared/motionLayers
 *  decides per element, per frame) */
export const LAYER_TRANSFORM_PROPS = [
  'x',
  'y',
  'scale',
  'scaleX',
  'scaleY',
  'rotate',
  'skewX',
  'skewY',
  'opacity',
] as const
export type LayerTransformProp = (typeof LAYER_TRANSFORM_PROPS)[number]

/**
 * Promotion and rendering hints for one element track. `mode`:
 * `'auto'` (default) promotes when the track carries an effect, a blend, a
 * matte or masks; `'on'` forces a layer; `'off'` keeps the element in the
 * base raster even with a stack (the stack then simply does not draw — the
 * agent's escape hatch). `visible: false` keeps the layer out of the picture
 * but lets it serve as a matte/effect-input source. `transform` picks where
 * the track transform runs; absent = measured (compositor when safe, CSS
 * fallback). `pad`/`scale` are overrides — the plan computes both when unset.
 */
export interface LayerSpec {
  mode?: 'auto' | 'on' | 'off'
  /** false = matte/effect-input source only, never drawn */
  visible?: boolean
  /** where the track transform runs; unset = measured */
  transform?: 'compositor' | 'css'
  /** px added around the element's box on every side, ≤ MAX_LAYER_PAD;
   *  the plan adds effect growth on top, clamped */
  pad?: number
  /** texture px per frame px; unset = planned from zoom */
  scale?: number
  /** P1: per-layer motion blur samples; stored now, drawn later */
  motionBlur?: boolean
}

/** a matte borrows another element layer's alpha or luma as this layer's
 *  coverage (P1 renders it; the field stores and plans already) */
export interface LayerMatte {
  /** track id of the source element layer, same frame */
  source: string
  channel?: 'alpha' | 'luma'
  invert?: boolean
}

/** a vector hole/window inside a layer's coverage (P1 renders it; the field
 *  stores and plans already) */
export interface LayerMask {
  id: string
  shape:
    | { type: 'rect'; x: number; y: number; width: number; height: number; radius?: number }
    | { type: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
    | { type: 'path'; d: string }
  mode?: 'add' | 'subtract' | 'intersect' | 'difference'
  invert?: boolean
  /** px of edge blur */
  feather?: number
  /** px the shape grows (positive) or shrinks (negative) */
  expansion?: number
  /** 0..1 — the mask's coverage scale */
  opacity?: number
}

/* ---- the director's intent (motion-pro P0) ----
 * The notes on a storyboard are intent, not a script; the Direction is the
 * treatment the agent writes before building: mood, motion language,
 * rhythm, look, the hero moment. It persists on the composition so a later
 * pass — human or agent — re-reads why the film looks the way it does. */

/** critique passes the director loop runs by default */
export const CRITIQUE_PASS_DEFAULT = 3
/** the bounded maximum — a run never critques more than this */
export const CRITIQUE_PASS_MAX = 5

export interface DirectionBeat {
  /** seconds this beat holds on screen */
  seconds: number
  /** what the beat says — intent, not a script */
  note?: string
  /** how the beat hands over to the next: 'cut' (default — the camera
   *  holds, then jumps), 'move' (an eased travel), 'push' (travel toward
   *  the next shot with a slight dolly), 'whip' (a fast move), 'fade' (a
   *  slow drift — the honest camera-film shape of a dissolve) */
  transition?: string
}

export interface Direction {
  /** one paragraph — mood, motion language, rhythm, the hero moment */
  treatment?: string
  /** the film's beats in order; their seconds tile the timeline */
  beats?: DirectionBeat[]
  /** a named look (shared/motionLooks.ts id) or a described one */
  look?: string
  /** reference/gallery ids the film riffs on */
  references?: string[]
  /** free notes: rhythm ('slow-fast-slow', bpm), palette, sound */
  rhythm?: string
  palette?: string
  /** critique passes the director loop runs; default 3, hard max 5 */
  passes?: number
}

export const TRACK_KINDS = ['camera', 'element', 'clip', 'audio', 'caption', 'adjustment'] as const
export type MotionTrackKind = (typeof TRACK_KINDS)[number]

export function isTrackKind(v: unknown): v is MotionTrackKind {
  return typeof v === 'string' && (TRACK_KINDS as readonly string[]).includes(v)
}

/**
 * One timeline lane. Order in `Composition.tracks` is display order, top to
 * bottom. `camera` (at most one) holds the camera keyframes. `element`
 * targets one element in one frame (`frameId` + its `data-doop-id`) and
 * holds that element's keyframes. `clip`, `audio` and `caption` hold clips.
 * `adjustment` holds effect stacks applied to everything below it (its clips
 * gate the window). `muted` silences audio lanes and hides visual lanes in
 * output.
 */
export interface MotionTrack {
  id: string
  kind: MotionTrackKind
  name?: string
  muted?: boolean
  /** element tracks only: the frame whose element this animates */
  frameId?: string
  /** element tracks only: the target's data-doop-id inside the frame */
  elementId?: string
  keyframes?: MotionKeyframe[]
  clips?: MotionClip[]
  /** the track's effect stack, applied in order (motion-pro P1) */
  effects?: EffectInstance[]
  /** how the layer composites onto what's below it — element tracks blend
   *  through the compositor (motion-elements P0) */
  blend?: BlendMode
  /** element tracks only: promotion and render hints for the element layer */
  layer?: LayerSpec
  /** element tracks only: borrow another layer's coverage (draws in P1) */
  matte?: LayerMatte
  /** element tracks only: vector windows inside the layer (draws in P1) */
  masks?: LayerMask[]
}

/* ---- the composition ---- */

/**
 * A page's timeline — the whole contract. One per page; created by the
 * timeline editor, `set_composition` or `animate_storyboard`, deleted with
 * the page. `revision` bumps on every write and powers optimistic
 * concurrency (`expectedRevision` on PUT/PATCH).
 */
export interface Composition {
  id: string
  canvasId: string
  pageId: string
  /** film length in seconds */
  duration: number
  /** frames per second — the seek grid and the default render fps */
  fps: number
  /** output raster size, px — also the camera's aspect */
  width: number
  height: number
  /** the time a reduced-motion or static view rests on; default 0 */
  posterTime?: number
  tracks: MotionTrack[]
  /** the director's treatment this film was built from (motion-pro P0) */
  direction?: Direction
  /** filmic shutter: samples the scene at K sub-times inside the window and
   *  averages — deterministic by construction (motion-pro P1) */
  motionBlur?: { shutter: number; samples?: number }
  revision: number
  createdAt: number
  updatedAt: number
  /** name of the last writer (a person or an agent) */
  updatedBy: string
}

/* ---- patch ops ----
 * The multiplayer edit protocol: REST PATCH and `patch_composition` take a
 * list of these; the server validates then applies them atomically. */

export type CompositionOp =
  | { op: 'set_meta'; duration?: number; fps?: number; width?: number; height?: number; posterTime?: number }
  | { op: 'add_track'; track: MotionTrack }
  | { op: 'remove_track'; trackId: string }
  | { op: 'update_track'; trackId: string; name?: string; muted?: boolean }
  | { op: 'move_track'; trackId: string; index: number }
  /** the "camera move" op: upserts a camera keyframe at `t` for every field
   *  given, creating the camera track when missing */
  | {
      op: 'set_camera'
      t: number
      x?: number
      y?: number
      zoom?: number
      rotation?: number
      easing?: MotionEasing
    }
  | { op: 'add_keyframe'; trackId: string; keyframe: MotionKeyframe }
  | {
      op: 'update_keyframe'
      trackId: string
      keyframeId: string
      t?: number
      value?: number | string
      easing?: MotionEasing
    }
  | { op: 'remove_keyframe'; trackId: string; keyframeId: string }
  | { op: 'add_clip'; trackId: string; clip: MotionClip }
  | {
      op: 'update_clip'
      trackId: string
      clipId: string
      start?: number
      duration?: number
      mediaStart?: number
      speed?: number
      gain?: number
      fadeIn?: number
      fadeOut?: number
      muted?: boolean
      name?: string
      source?: MotionClipSource
      /** null clears the transition (back to a hard cut) */
      transition?: MotionTransition | null
    }
  | { op: 'remove_clip'; trackId: string; clipId: string }
  /** the director's intent on the composition; null clears it */
  | { op: 'set_direction'; direction: Direction | null }
  /** filmic shutter on the composition; null clears it */
  | { op: 'set_motion_blur'; motionBlur: { shutter: number; samples?: number } | null }
  /* effect-stack ops (motion-pro P1): the stack lives on the track; the ops
     address effects by their instance id */
  | { op: 'add_effect'; trackId: string; effect: EffectInstance; index?: number }
  | {
      op: 'update_effect'
      trackId: string
      effectId: string
      enabled?: boolean
      params?: Record<string, number | string | boolean>
      seed?: number
      mix?: number
      /** null clears the override back to 'normal' */
      blend?: BlendMode | null
    }
  | { op: 'remove_effect'; trackId: string; effectId: string }
  /** the whole stack reordered; every existing id must appear exactly once */
  | { op: 'reorder_effects'; trackId: string; effectIds: string[] }
  /** how the layer composites onto what's below; null back to normal */
  | { op: 'set_blend'; trackId: string; blend: BlendMode | null }
  /* element-layer ops (motion-elements P0): the layer contract on an
     element track; matte/masks store now and draw in P1 */
  | { op: 'set_layer'; trackId: string; layer: LayerSpec | null }
  | { op: 'set_matte'; trackId: string; matte: LayerMatte | null }
  /** the whole mask list, replaced atomically; null clears it */
  | { op: 'set_masks'; trackId: string; masks: LayerMask[] | null }
  | { op: 'add_mask'; trackId: string; mask: LayerMask }
  | { op: 'update_mask'; trackId: string; maskId: string; mask: LayerMask }
  | { op: 'remove_mask'; trackId: string; maskId: string }

/* ---- per-frame motion data (the data-doop-motion block) ----
 * Frame-authored keyframes ride the frame's HTML — versions, copy and MCP
 * frame writes keep them — while the composition's element tracks are the
 * timeline editor's data. The runtime merges both (see motionRuntime). */

export interface FrameMotionKeyframe {
  /** the target element's data-doop-id inside the frame */
  el: string
  prop: string
  t: number
  value: number | string
  ease?: MotionEasing
}

/* ---- text animators (proposal 14.5) ----
 * The element's text stays one editable string; `data-doop-split` names the
 * unit split and an animator spec here says how the units arrive. The
 * player derives the units at runtime; `expandTextAnimator` (shared/
 * motionText.ts) folds a spec into ordinary keyframes on generated unit
 * targets — `unitSelector(el, i)` — so renderers need no DOM. */

export const TEXT_ANIMATOR_PRESETS = [
  'rise-blur',
  'typewriter',
  'scale-pop',
  'mask-wipe',
  'tracking-in',
  'scramble',
] as const
export type TextAnimatorPreset = (typeof TEXT_ANIMATOR_PRESETS)[number]

export const TEXT_ORDERS = ['forward', 'center', 'random'] as const
export type TextOrder = (typeof TEXT_ORDERS)[number]

export interface FrameTextAnimator {
  /** the text element's data-doop-id (which carries data-doop-split) */
  el: string
  split: TextSplit
  preset: TextAnimatorPreset
  /** seconds on the composition clock the first unit starts */
  start: number
  /** per-unit animation length, seconds */
  duration: number
  /** seconds between unit starts */
  stagger: number
  /** unit order; default forward */
  order?: TextOrder
  /** per-unit easing; default per preset */
  ease?: MotionEasing
  /** seed for 'random' order and the 'scramble' preset */
  seed?: number
}

export interface FrameMotionBlock {
  v: 1
  keyframes: FrameMotionKeyframe[]
  animators?: FrameTextAnimator[]
}

export function parseMotionBlock(text: string): FrameMotionBlock | null {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(json) || json.v !== 1 || !Array.isArray(json.keyframes)) return null
  const keyframes: FrameMotionKeyframe[] = []
  for (const raw of json.keyframes) {
    if (!isRecord(raw)) return null
    const { el, prop, t, value, ease } = raw
    if (typeof el !== 'string' || !el || typeof prop !== 'string' || !PROPERTY_RE.test(prop)) return null
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) return null
    if (typeof value !== 'number' && typeof value !== 'string') return null
    let easing: MotionEasing | undefined
    if (ease !== undefined) {
      const parsed = parseEasing(ease)
      if (!parsed) return null
      easing = parsed
    }
    keyframes.push({ el, prop, t, value: value as number | string, ease: easing })
  }
  const block: FrameMotionBlock = { v: 1, keyframes }
  if (json.animators !== undefined) {
    if (!Array.isArray(json.animators)) return null
    const animators: FrameTextAnimator[] = []
    for (const raw of json.animators) {
      const parsed = parseTextAnimator(raw)
      if (!parsed) return null
      animators.push(parsed)
    }
    block.animators = animators
  }
  return block
}

function parseTextAnimator(input: unknown): FrameTextAnimator | null {
  if (!isRecord(input)) return null
  const { el, split, preset, start, duration, stagger, order, ease, seed } = input
  if (typeof el !== 'string' || !el || el.length > 100) return null
  if (!TEXT_SPLITS.includes(split as TextSplit)) return null
  if (!TEXT_ANIMATOR_PRESETS.includes(preset as TextAnimatorPreset)) return null
  if (
    ![start, duration, stagger].every((v) => typeof v === 'number' && Number.isFinite(v)) ||
    (start as number) < 0 ||
    (duration as number) <= 0 ||
    (stagger as number) < 0
  ) {
    return null
  }
  const out: FrameTextAnimator = {
    el,
    split: split as TextSplit,
    preset: preset as TextAnimatorPreset,
    start: start as number,
    duration: duration as number,
    stagger: stagger as number,
  }
  if (order !== undefined) {
    if (!TEXT_ORDERS.includes(order as TextOrder)) return null
    out.order = order as TextOrder
  }
  if (ease !== undefined) {
    const parsed = parseEasing(ease)
    if (!parsed) return null
    out.ease = parsed
  }
  if (seed !== undefined) {
    if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0) return null
    out.seed = seed
  }
  return out
}

/* ---- render jobs ---- */

/* `gif`/`pngseq` join the containers: a GIF needs the ffmpeg palette pass
 * and a pngseq uploads a zip of the stills (sniffed on upload) */
export const RENDER_FORMATS = ['mp4', 'webm', 'gif', 'pngseq'] as const
export type RenderFormat = (typeof RENDER_FORMATS)[number]

/**
 * Who produces the file. `browser` (MediaRecorder/WebCodecs in the page),
 * `desktop` (the Tauri shell — deterministic seeks plus an allowlisted local
 * ffmpeg), `blender` (the desktop shell driving Blender per frame, phase
 * 4) and `server` (the instance's own headless renderer through the
 * renderer gate at background priority — capped at 60 s, 1080p and 30 fps,
 * one open render per account, phase 5).
 */
export const RENDER_TARGETS = ['browser', 'desktop', 'server', 'blender'] as const
export type RenderTarget = (typeof RENDER_TARGETS)[number]
export const RENDER_TARGETS_MVP: readonly RenderTarget[] = ['browser', 'desktop', 'blender', 'server']

/** The render engine a `blender`-target job asks Blender to use. `octane`
 *  stays a name Blender interprets — there is no Octane integration. */
export const BLENDER_ENGINES = ['eevee', 'cycles', 'octane'] as const
export type BlenderEngine = (typeof BLENDER_ENGINES)[number]

export const RENDER_STATUSES = ['queued', 'rendering', 'encoding', 'done', 'failed', 'canceled'] as const
export type RenderStatus = (typeof RENDER_STATUSES)[number]

/**
 * One export. Jobs are records, not a queue runner: the browser or the
 * desktop claims one via PATCH (status rendering), reports progress, then
 * PUTs the finished file to the upload endpoint, which stores it as an /a/
 * asset and marks the job done.
 */
export interface RenderJob {
  id: string
  canvasId: string
  pageId: string
  compositionId: string
  format: RenderFormat
  target: RenderTarget
  /** blender-target jobs only: which engine Blender renders with */
  engine?: BlenderEngine
  width: number
  height: number
  fps: number
  /** seconds of composition time to render */
  range: { start: number; end: number }
  status: RenderStatus
  /** 0..1 across capture and encode */
  progress: number
  /** set once the upload landed; the file serves at /a/<outputAssetId> */
  outputAssetId?: string
  error?: string
  /** the client (browser tab) or device (desktop) that owns the render */
  claimedBy?: string
  claimedAt?: number
  createdBy: string
  createdByName: string
  createdAt: number
  updatedAt: number
  finishedAt?: number
}

/* ---- lint findings ---- */

export type MotionLintSeverity = 'error' | 'warning'

export interface MotionLintIssue {
  /** stable rule id — 'MO-01' style; names in shared/motionLint.ts */
  rule: string
  severity: MotionLintSeverity
  message: string
  frameId?: string
  /** the offending HTML fragment, trimmed for display */
  snippet?: string
}

/* ---- validation ---- */

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value })
const bad = <T = never>(error: string): ParseResult<T> => ({ ok: false, error })

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseId(v: unknown, name: string): ParseResult<string> {
  if (typeof v !== 'string' || !MOTION_ID_RE.test(v)) return bad(`${name} must be a 1-100 char id`)
  return ok(v)
}

function parseSeconds(v: unknown, name: string, min: number, max: number): ParseResult<number> {
  if (typeof v !== 'number' || !Number.isFinite(v)) return bad(`${name} must be a number`)
  if (v < min || v > max) return bad(`${name} must be in [${min}, ${max}]`)
  return ok(v)
}

function parseSize(v: unknown, name: string): ParseResult<number> {
  if (typeof v !== 'number' || !Number.isInteger(v)) return bad(`${name} must be an integer`)
  if (v < MOTION_LIMITS.MIN_SIZE || v > MOTION_LIMITS.MAX_SIZE) {
    return bad(`${name} must be in [${MOTION_LIMITS.MIN_SIZE}, ${MOTION_LIMITS.MAX_SIZE}]`)
  }
  return ok(v)
}

function parseKeyframe(input: unknown, duration: number): ParseResult<MotionKeyframe> {
  if (!isRecord(input)) return bad('keyframe must be an object')
  const id = parseId(input.id, 'keyframe.id')
  if (!id.ok) return id
  if (
    typeof input.property !== 'string' ||
    (!PROPERTY_RE.test(input.property) && !FX_PROPERTY_RE.test(input.property))
  ) {
    return bad('keyframe.property must be a property name, --custom-property or fx:<id>.<param>')
  }
  const t = parseSeconds(input.t, 'keyframe.t', 0, duration)
  if (!t.ok) return t
  if (typeof input.value !== 'number' && typeof input.value !== 'string') {
    return bad('keyframe.value must be a number or a string')
  }
  if (typeof input.value === 'number' && !Number.isFinite(input.value)) return bad('keyframe.value must be finite')
  if (typeof input.value === 'string' && input.value.length > MOTION_LIMITS.MAX_VALUE_TEXT) {
    return bad(`keyframe.value is over ${MOTION_LIMITS.MAX_VALUE_TEXT} chars`)
  }
  const easing = parseEasing(input.easing ?? { type: 'linear' })
  if (!easing) return bad('keyframe.easing is not a valid easing')
  const out: MotionKeyframe = { id: id.value, property: input.property, t: t.value, value: input.value, easing }
  if (input.preset !== undefined) {
    if (typeof input.preset !== 'string' || input.preset.length === 0 || input.preset.length > MOTION_LIMITS.MAX_NAME) {
      return bad('keyframe.preset must be a short preset id')
    }
    out.preset = input.preset
  }
  return ok(out)
}

function parseClipSource(input: unknown): ParseResult<MotionClipSource> {
  if (!isRecord(input) || typeof input.type !== 'string') return bad('clip.source must be an object with a type')
  if (input.type === 'frame') {
    const frameId = parseId(input.frameId, 'clip.source.frameId')
    if (!frameId.ok) return frameId
    return ok({ type: 'frame', frameId: frameId.value })
  }
  if (input.type === 'library') {
    const itemId = parseId(input.itemId, 'clip.source.itemId')
    if (!itemId.ok) return itemId
    const out: MotionClipSource = { type: 'library', itemId: itemId.value }
    if (input.variantId !== undefined) {
      const variantId = parseId(input.variantId, 'clip.source.variantId')
      if (!variantId.ok) return variantId
      out.variantId = variantId.value
    }
    return ok(out)
  }
  if (input.type === 'asset') {
    const assetId = parseId(input.assetId, 'clip.source.assetId')
    if (!assetId.ok) return assetId
    return ok({ type: 'asset', assetId: assetId.value })
  }
  if (input.type === 'caption') {
    if (typeof input.text !== 'string' || input.text.length < 1) return bad('clip.source.text is required')
    if (input.text.length > MOTION_LIMITS.MAX_CAPTION_TEXT) {
      return bad(`clip.source.text is over ${MOTION_LIMITS.MAX_CAPTION_TEXT} chars`)
    }
    const out: MotionClipSource = { type: 'caption', text: input.text }
    if (input.style !== undefined) {
      if (typeof input.style !== 'string' || input.style.length > MOTION_LIMITS.MAX_NAME) {
        return bad('clip.source.style must be a short preset name')
      }
      out.style = input.style
    }
    if (input.words !== undefined) {
      if (!Array.isArray(input.words) || input.words.length > 512) return bad('clip.source.words must be ≤512 words')
      const words: TranscriptWord[] = []
      for (const w of input.words) {
        const parsed = parseTranscriptWord(w)
        if (!parsed) return bad('clip.source.words must be {text,start,end}')
        words.push(parsed)
      }
      out.words = words
    }
    return ok(out)
  }
  if (input.type === 'adjustment') {
    /* an adjustment clip carries no pixels of its own — its window gates the
       track's effect stack over the layers below it */
    return ok({ type: 'adjustment' })
  }
  if (input.type === '3d') {
    const assetId = parseId(input.assetId, 'clip.source.assetId')
    if (!assetId.ok) return assetId
    const out: MotionClipSource = { type: '3d', assetId: assetId.value }
    if (input.fallbackAssetId !== undefined) {
      const fallback = parseId(input.fallbackAssetId, 'clip.source.fallbackAssetId')
      if (!fallback.ok) return fallback
      out.fallbackAssetId = fallback.value
    }
    if (input.driver !== undefined) {
      if (!DRIVERS.includes(input.driver as MotionDriver)) {
        return bad(`clip.source.driver must be one of ${DRIVERS.join(', ')}`)
      }
      out.driver = input.driver as MotionDriver
    }
    return ok(out)
  }
  return bad(`unknown clip source type "${input.type}"`)
}

/** validates one transcript word: non-empty text, 0 ≤ start < end, finite */
export function parseTranscriptWord(input: unknown): TranscriptWord | null {
  if (!isRecord(input)) return null
  const { text, start, end } = input
  if (typeof text !== 'string' || text.length < 1 || text.length > 200) return null
  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)) {
    return null
  }
  if (start < 0 || end <= start || end > MOTION_LIMITS.MAX_DURATION_S) return null
  const out: TranscriptWord = { text, start, end }
  if (typeof input.confidence === 'number' && Number.isFinite(input.confidence)) out.confidence = input.confidence
  if (typeof input.speaker === 'string' && input.speaker.length <= 40) out.speaker = input.speaker
  return out
}

function parseClip(input: unknown, duration: number): ParseResult<MotionClip> {
  if (!isRecord(input)) return bad('clip must be an object')
  const id = parseId(input.id, 'clip.id')
  if (!id.ok) return id
  const start = parseSeconds(input.start, 'clip.start', 0, duration)
  if (!start.ok) return start
  const length = parseSeconds(input.duration, 'clip.duration', 0.01, duration)
  if (!length.ok) return length
  const source = parseClipSource(input.source)
  if (!source.ok) return source
  const clip: MotionClip = { id: id.value, start: start.value, duration: length.value, source: source.value }
  if (input.name !== undefined) {
    if (typeof input.name !== 'string' || input.name.length > MOTION_LIMITS.MAX_NAME) return bad('clip.name too long')
    clip.name = input.name
  }
  if (input.mediaStart !== undefined) {
    const ms = parseSeconds(input.mediaStart, 'clip.mediaStart', 0, MOTION_LIMITS.MAX_DURATION_S)
    if (!ms.ok) return ms
    clip.mediaStart = ms.value
  }
  if (input.gain !== undefined) {
    const g = parseSeconds(input.gain, 'clip.gain', 0, 4)
    if (!g.ok) return g
    clip.gain = g.value
  }
  if (input.muted !== undefined) {
    if (typeof input.muted !== 'boolean') return bad('clip.muted must be a boolean')
    clip.muted = input.muted
  }
  if (input.speed !== undefined) {
    const s = parseSeconds(input.speed, 'clip.speed', 0.25, 4)
    if (!s.ok) return s
    clip.speed = s.value
  }
  for (const f of ['fadeIn', 'fadeOut'] as const) {
    if (input[f] !== undefined) {
      const n = parseSeconds(input[f], `clip.${f}`, 0, length.value)
      if (!n.ok) return n
      clip[f] = n.value
    }
  }
  if (input.transition !== undefined) {
    const transition = parseTransition(input.transition)
    if (!transition) return bad('clip.transition is not a valid transition')
    clip.transition = transition
  }
  return ok(clip)
}

function parseTransition(input: unknown): MotionTransition | null {
  if (!isRecord(input)) return null
  const { kind, duration, token, direction, easing } = input
  if (!TRANSITION_KINDS.includes(kind as TransitionKind) || kind === 'cut') return null
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > 60) return null
  const out: MotionTransition = { kind: kind as TransitionKind, duration }
  if (token !== undefined) {
    if (typeof token !== 'string' || !token.startsWith('--dur-') || token.length > 60) return null
    out.token = token
  }
  if (direction !== undefined) {
    if (!TRANSITION_DIRECTIONS.includes(direction as TransitionDirection)) return null
    out.direction = direction as TransitionDirection
  }
  if (easing !== undefined) {
    const parsed = parseEasing(easing)
    if (!parsed) return null
    out.easing = parsed
  }
  return out
}

/** shape-level check of one effect — the registry's param ranges are the
 *  lint's job (shared/motionFx.ts), so an older effect id still parses */
export function parseEffectInstance(input: unknown): ParseResult<EffectInstance> {
  if (!isRecord(input)) return bad('effect must be an object')
  const id = parseId(input.id, 'effect.id')
  if (!id.ok) return id
  if (typeof input.fx !== 'string' || !/^[a-z][a-z0-9-]{0,59}$/.test(input.fx)) {
    return bad('effect.fx must be a registry id (lowercase, dashes)')
  }
  const spec = effectSpec(input.fx)
  if (!spec) return bad(`effect.fx ${input.fx} is not in the registry`)
  const out: EffectInstance = { id: id.value, fx: input.fx, params: {} }
  if (input.params !== undefined) {
    if (!isRecord(input.params)) return bad('effect.params must be an object')
    for (const [k, v] of Object.entries(input.params)) {
      if (typeof v !== 'number' && typeof v !== 'string' && typeof v !== 'boolean') {
        return bad(`effect.params.${k} must be a number, string or boolean`)
      }
    }
    const specError = spec.validate(input.params)
    if (specError) return bad(specError)
    out.params = input.params as Record<string, number | string | boolean>
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') return bad('effect.enabled must be a boolean')
    out.enabled = input.enabled
  }
  if (input.seed !== undefined) {
    if (typeof input.seed !== 'number' || !Number.isInteger(input.seed) || input.seed < 0) {
      return bad('effect.seed must be a non-negative integer')
    }
    out.seed = input.seed
  }
  if (input.mix !== undefined) {
    if (typeof input.mix !== 'number' || !Number.isFinite(input.mix) || input.mix < 0 || input.mix > 1) {
      return bad('effect.mix must be in [0, 1]')
    }
    out.mix = input.mix
  }
  if (input.blend !== undefined) {
    if (!BLEND_MODES.includes(input.blend as BlendMode)) {
      return bad(`effect.blend must be one of ${BLEND_MODES.join(', ')}`)
    }
    out.blend = input.blend as BlendMode
  }
  return ok(out)
}

function parseDirection(input: unknown): Direction | null {
  if (!isRecord(input)) return null
  const out: Direction = {}
  if (input.treatment !== undefined) {
    if (typeof input.treatment !== 'string' || input.treatment.length > 4000) return null
    out.treatment = input.treatment
  }
  if (input.look !== undefined) {
    if (typeof input.look !== 'string' || input.look.length > 200) return null
    out.look = input.look
  }
  if (input.references !== undefined) {
    if (!Array.isArray(input.references) || input.references.length > 50) return null
    if (!input.references.every((r) => typeof r === 'string' && r.length <= 200)) return null
    out.references = input.references as string[]
  }
  if (input.rhythm !== undefined) {
    if (typeof input.rhythm !== 'string' || input.rhythm.length > 200) return null
    out.rhythm = input.rhythm
  }
  if (input.palette !== undefined) {
    if (typeof input.palette !== 'string' || input.palette.length > 400) return null
    out.palette = input.palette
  }
  if (input.passes !== undefined) {
    if (typeof input.passes !== 'number' || !Number.isInteger(input.passes) || input.passes < 1) return null
    out.passes = Math.min(input.passes, CRITIQUE_PASS_MAX)
  }
  if (input.beats !== undefined) {
    if (!Array.isArray(input.beats) || input.beats.length > 200) return null
    const beats: DirectionBeat[] = []
    for (const raw of input.beats) {
      if (!isRecord(raw)) return null
      if (typeof raw.seconds !== 'number' || !Number.isFinite(raw.seconds) || raw.seconds <= 0 || raw.seconds > 60) {
        return null
      }
      const beat: DirectionBeat = { seconds: raw.seconds }
      if (raw.note !== undefined) {
        if (typeof raw.note !== 'string' || raw.note.length > 1000) return null
        beat.note = raw.note
      }
      if (raw.transition !== undefined) {
        if (typeof raw.transition !== 'string' || raw.transition.length > 40) return null
        beat.transition = raw.transition
      }
      beats.push(beat)
    }
    out.beats = beats
  }
  return out
}

export function parseLayerSpec(input: unknown): ParseResult<LayerSpec> {
  if (!isRecord(input)) return bad('layer must be an object')
  const out: LayerSpec = {}
  if (input.mode !== undefined) {
    if (input.mode !== 'auto' && input.mode !== 'on' && input.mode !== 'off') {
      return bad('layer.mode must be auto, on or off')
    }
    out.mode = input.mode
  }
  if (input.visible !== undefined) {
    if (typeof input.visible !== 'boolean') return bad('layer.visible must be a boolean')
    out.visible = input.visible
  }
  if (input.transform !== undefined) {
    if (input.transform !== 'compositor' && input.transform !== 'css') {
      return bad('layer.transform must be compositor or css')
    }
    out.transform = input.transform
  }
  if (input.pad !== undefined) {
    const pad = parseSeconds(input.pad, 'layer.pad', 0, MOTION_LIMITS.MAX_LAYER_PAD)
    if (!pad.ok) return pad
    out.pad = pad.value
  }
  if (input.scale !== undefined) {
    if (typeof input.scale !== 'number' || !Number.isFinite(input.scale) || input.scale <= 0 || input.scale > 16) {
      return bad('layer.scale must be in (0, 16]')
    }
    out.scale = input.scale
  }
  if (input.motionBlur !== undefined) {
    if (typeof input.motionBlur !== 'boolean') return bad('layer.motionBlur must be a boolean')
    out.motionBlur = input.motionBlur
  }
  return ok(out)
}

export function parseLayerMatte(input: unknown): ParseResult<LayerMatte> {
  if (!isRecord(input)) return bad('matte must be an object')
  const source = parseId(input.source, 'matte.source')
  if (!source.ok) return source
  const out: LayerMatte = { source: source.value }
  if (input.channel !== undefined) {
    if (input.channel !== 'alpha' && input.channel !== 'luma') return bad('matte.channel must be alpha or luma')
    out.channel = input.channel
  }
  if (input.invert !== undefined) {
    if (typeof input.invert !== 'boolean') return bad('matte.invert must be a boolean')
    out.invert = input.invert
  }
  return ok(out)
}

const MASK_MODES = ['add', 'subtract', 'intersect', 'difference'] as const

export function parseLayerMask(input: unknown): ParseResult<LayerMask> {
  if (!isRecord(input)) return bad('mask must be an object')
  const id = parseId(input.id, 'mask.id')
  if (!id.ok) return id
  if (!isRecord(input.shape) || typeof input.shape.type !== 'string')
    return bad('mask.shape must be an object with a type')
  let shape: LayerMask['shape']
  if (input.shape.type === 'rect') {
    const { x, y, width, height, radius } = input.shape
    if (![x, y, width, height].every((v) => typeof v === 'number' && Number.isFinite(v))) {
      return bad('mask.shape rect needs numeric x, y, width, height')
    }
    shape = { type: 'rect', x: x as number, y: y as number, width: width as number, height: height as number }
    if (radius !== undefined) {
      if (typeof radius !== 'number' || !Number.isFinite(radius) || radius < 0)
        return bad('mask.shape.radius must be ≥ 0')
      shape.radius = radius
    }
  } else if (input.shape.type === 'ellipse') {
    const { cx, cy, rx, ry } = input.shape
    if (![cx, cy, rx, ry].every((v) => typeof v === 'number' && Number.isFinite(v))) {
      return bad('mask.shape ellipse needs numeric cx, cy, rx, ry')
    }
    shape = { type: 'ellipse', cx: cx as number, cy: cy as number, rx: rx as number, ry: ry as number }
  } else if (input.shape.type === 'path') {
    if (typeof input.shape.d !== 'string' || input.shape.d.length < 1 || input.shape.d.length > 20000) {
      return bad('mask.shape path needs a d string')
    }
    shape = { type: 'path', d: input.shape.d }
  } else {
    return bad('mask.shape.type must be rect, ellipse or path')
  }
  const out: LayerMask = { id: id.value, shape }
  if (input.mode !== undefined) {
    if (!MASK_MODES.includes(input.mode as (typeof MASK_MODES)[number])) {
      return bad(`mask.mode must be one of ${MASK_MODES.join(', ')}`)
    }
    out.mode = input.mode as LayerMask['mode']
  }
  if (input.invert !== undefined) {
    if (typeof input.invert !== 'boolean') return bad('mask.invert must be a boolean')
    out.invert = input.invert
  }
  if (input.feather !== undefined) {
    const n = parseSeconds(input.feather, 'mask.feather', 0, MOTION_LIMITS.MAX_LAYER_PAD)
    if (!n.ok) return n
    out.feather = n.value
  }
  if (input.expansion !== undefined) {
    const n = parseSeconds(input.expansion, 'mask.expansion', -MOTION_LIMITS.MAX_LAYER_PAD, MOTION_LIMITS.MAX_LAYER_PAD)
    if (!n.ok) return n
    out.expansion = n.value
  }
  if (input.opacity !== undefined) {
    const n = parseSeconds(input.opacity, 'mask.opacity', 0, 1)
    if (!n.ok) return n
    out.opacity = n.value
  }
  return ok(out)
}

function parseMotionBlur(input: unknown): { shutter: number; samples?: number } | null {
  if (!isRecord(input)) return null
  const { shutter, samples } = input
  if (typeof shutter !== 'number' || !Number.isFinite(shutter) || shutter < 0 || shutter > 360) return null
  const out: { shutter: number; samples?: number } = { shutter }
  if (samples !== undefined) {
    if (typeof samples !== 'number' || !Number.isInteger(samples) || samples < 2 || samples > 64) return null
    out.samples = samples
  }
  return out
}

export function parseTrack(input: unknown, duration: number): ParseResult<MotionTrack> {
  if (!isRecord(input)) return bad('track must be an object')
  const id = parseId(input.id, 'track.id')
  if (!id.ok) return id
  if (!isTrackKind(input.kind)) return bad(`track.kind must be one of ${TRACK_KINDS.join(', ')}`)
  const track: MotionTrack = { id: id.value, kind: input.kind }
  if (input.name !== undefined) {
    if (typeof input.name !== 'string' || input.name.length > MOTION_LIMITS.MAX_NAME) return bad('track.name too long')
    track.name = input.name
  }
  if (input.muted !== undefined) {
    if (typeof input.muted !== 'boolean') return bad('track.muted must be a boolean')
    track.muted = input.muted
  }
  if (input.frameId !== undefined) {
    const frameId = parseId(input.frameId, 'track.frameId')
    if (!frameId.ok) return frameId
    track.frameId = frameId.value
  }
  if (input.elementId !== undefined) {
    const elementId = parseId(input.elementId, 'track.elementId')
    if (!elementId.ok) return elementId
    track.elementId = elementId.value
  }
  if (input.effects !== undefined) {
    if (!Array.isArray(input.effects) || input.effects.length > 20) {
      return bad('track.effects must be an array of at most 20')
    }
    const effects: EffectInstance[] = []
    const seen = new Set<string>()
    for (const raw of input.effects) {
      const fx = parseEffectInstance(raw)
      if (!fx.ok) return fx
      if (seen.has(fx.value.id)) return bad(`duplicate effect id ${fx.value.id}`)
      seen.add(fx.value.id)
      effects.push(fx.value)
    }
    track.effects = effects
  }
  if (input.blend !== undefined) {
    if (input.blend !== null && !BLEND_MODES.includes(input.blend as BlendMode)) {
      return bad(`track.blend must be one of ${BLEND_MODES.join(', ')}`)
    }
    if (input.blend !== null) track.blend = input.blend as BlendMode
  }
  if (input.layer !== undefined && input.layer !== null) {
    const layer = parseLayerSpec(input.layer)
    if (!layer.ok) return layer
    track.layer = layer.value
  }
  if (input.matte !== undefined && input.matte !== null) {
    const matte = parseLayerMatte(input.matte)
    if (!matte.ok) return matte
    track.matte = matte.value
  }
  if (input.masks !== undefined) {
    if (!Array.isArray(input.masks) || input.masks.length > 32) {
      return bad('track.masks must be an array of at most 32')
    }
    const masks: LayerMask[] = []
    const seen = new Set<string>()
    for (const raw of input.masks) {
      const mask = parseLayerMask(raw)
      if (!mask.ok) return mask
      if (seen.has(mask.value.id)) return bad(`duplicate mask id ${mask.value.id}`)
      seen.add(mask.value.id)
      masks.push(mask.value)
    }
    track.masks = masks
  }
  /* same renderer limits the ops enforce — a whole-body set_composition
     reparses through here, so refusing at parse time keeps an undrawn effect
     stack, blend or layer spec out of the model. Camera, adjustment and
     element tracks draw effects; only element tracks draw a blend or carry
     a layer contract (motion-elements P0). */
  if (input.kind !== 'camera' && input.kind !== 'adjustment' && input.kind !== 'element' && track.effects?.length) {
    return bad(`effects only draw on camera, adjustment and element tracks, not ${input.kind} tracks`)
  }
  if (track.blend != null && input.kind !== 'element') {
    return bad(`track blend only draws on element tracks, not ${input.kind} tracks`)
  }
  if ((track.layer != null || track.matte != null || track.masks != null) && input.kind !== 'element') {
    return bad(`layer, matte and masks only belong on element tracks, not ${input.kind} tracks`)
  }
  if (input.keyframes !== undefined) {
    if (!Array.isArray(input.keyframes)) return bad('track.keyframes must be an array')
    if (input.keyframes.length > MOTION_LIMITS.MAX_KEYFRAMES_PER_TRACK) {
      return bad(`track has over ${MOTION_LIMITS.MAX_KEYFRAMES_PER_TRACK} keyframes`)
    }
    const keyframes: MotionKeyframe[] = []
    const seen = new Set<string>()
    for (const raw of input.keyframes) {
      const kf = parseKeyframe(raw, duration)
      if (!kf.ok) return kf
      if (seen.has(kf.value.id)) return bad(`duplicate keyframe id ${kf.value.id}`)
      seen.add(kf.value.id)
      keyframes.push(kf.value)
    }
    track.keyframes = keyframes
  }
  if (input.clips !== undefined) {
    if (!Array.isArray(input.clips)) return bad('track.clips must be an array')
    if (input.clips.length > MOTION_LIMITS.MAX_CLIPS_PER_TRACK) {
      return bad(`track has over ${MOTION_LIMITS.MAX_CLIPS_PER_TRACK} clips`)
    }
    const clips: MotionClip[] = []
    const seen = new Set<string>()
    for (const raw of input.clips) {
      const clip = parseClip(raw, duration)
      if (!clip.ok) return clip
      if (seen.has(clip.value.id)) return bad(`duplicate clip id ${clip.value.id}`)
      seen.add(clip.value.id)
      clips.push(clip.value)
    }
    track.clips = clips
  }
  return ok(track)
}

/** the timeline fields a PUT sends: everything but the server-owned bookkeeping */
export interface CompositionBody {
  duration: number
  fps: number
  width: number
  height: number
  posterTime?: number
  tracks: MotionTrack[]
  direction?: Direction
  motionBlur?: { shutter: number; samples?: number }
}

export function parseCompositionBody(input: unknown): ParseResult<CompositionBody> {
  if (!isRecord(input)) return bad('body must be an object')
  const duration = parseSeconds(input.duration, 'duration', MOTION_LIMITS.MIN_DURATION_S, MOTION_LIMITS.MAX_DURATION_S)
  if (!duration.ok) return duration
  if (typeof input.fps !== 'number' || !Number.isInteger(input.fps)) return bad('fps must be an integer')
  if (input.fps < MOTION_LIMITS.MIN_FPS || input.fps > MOTION_LIMITS.MAX_FPS) {
    return bad(`fps must be in [${MOTION_LIMITS.MIN_FPS}, ${MOTION_LIMITS.MAX_FPS}]`)
  }
  const width = parseSize(input.width, 'width')
  if (!width.ok) return width
  const height = parseSize(input.height, 'height')
  if (!height.ok) return height
  const body: CompositionBody = {
    duration: duration.value,
    fps: input.fps,
    width: width.value,
    height: height.value,
    tracks: [],
  }
  if (input.posterTime !== undefined) {
    const pt = parseSeconds(input.posterTime, 'posterTime', 0, duration.value)
    if (!pt.ok) return pt
    body.posterTime = pt.value
  }
  if (input.direction !== undefined && input.direction !== null) {
    const direction = parseDirection(input.direction)
    if (!direction) return bad('direction is not a valid Direction')
    body.direction = direction
  }
  if (input.motionBlur !== undefined && input.motionBlur !== null) {
    const motionBlur = parseMotionBlur(input.motionBlur)
    if (!motionBlur) return bad('motionBlur must be {shutter: 0..360, samples?: 2..64}')
    body.motionBlur = motionBlur
  }
  if (input.tracks !== undefined) {
    if (!Array.isArray(input.tracks)) return bad('tracks must be an array')
    if (input.tracks.length > MOTION_LIMITS.MAX_TRACKS) return bad(`over ${MOTION_LIMITS.MAX_TRACKS} tracks`)
    const seen = new Set<string>()
    let camera = 0
    for (const raw of input.tracks) {
      const track = parseTrack(raw, duration.value)
      if (!track.ok) return track
      if (seen.has(track.value.id)) return bad(`duplicate track id ${track.value.id}`)
      seen.add(track.value.id)
      if (track.value.kind === 'camera') camera += 1
      if (camera > 1) return bad('at most one camera track')
      for (const kf of track.value.keyframes ?? []) {
        if (track.value.kind === 'camera' && !isCameraProperty(kf.property) && !isFxProperty(kf.property)) {
          return bad(`camera keyframe property must be one of ${CAMERA_PROPERTIES.join(', ')} or fx:<id>.<param>`)
        }
      }
      body.tracks.push(track.value)
    }
  }
  return ok(body)
}

/** validate a wire ops array — same checks the server applies before applying */
export function parseOps(input: unknown, duration: number): ParseResult<CompositionOp[]> {
  if (!Array.isArray(input)) return bad('ops must be an array')
  if (input.length > 200) return bad('over 200 ops in one request')
  const ops: CompositionOp[] = []
  for (const raw of input) {
    const op = parseOp(raw, duration)
    if (!op.ok) return op
    ops.push(op.value)
  }
  return ok(ops)
}

function parseOp(input: unknown, duration: number): ParseResult<CompositionOp> {
  if (!isRecord(input) || typeof input.op !== 'string') return bad('op must be an object with an op field')
  switch (input.op) {
    case 'set_meta': {
      const op: Extract<CompositionOp, { op: 'set_meta' }> = { op: 'set_meta' }
      if (input.duration !== undefined) {
        const d = parseSeconds(input.duration, 'duration', MOTION_LIMITS.MIN_DURATION_S, MOTION_LIMITS.MAX_DURATION_S)
        if (!d.ok) return d
        op.duration = d.value
      }
      if (input.fps !== undefined) {
        if (
          typeof input.fps !== 'number' ||
          !Number.isInteger(input.fps) ||
          input.fps < 1 ||
          input.fps > MOTION_LIMITS.MAX_FPS
        ) {
          return bad('fps must be an integer within limits')
        }
        op.fps = input.fps
      }
      if (input.width !== undefined) {
        const w = parseSize(input.width, 'width')
        if (!w.ok) return w
        op.width = w.value
      }
      if (input.height !== undefined) {
        const h = parseSize(input.height, 'height')
        if (!h.ok) return h
        op.height = h.value
      }
      if (input.posterTime !== undefined) {
        const p = parseSeconds(input.posterTime, 'posterTime', 0, MOTION_LIMITS.MAX_DURATION_S)
        if (!p.ok) return p
        op.posterTime = p.value
      }
      return ok(op)
    }
    case 'add_track': {
      const track = parseTrack(input.track, duration)
      if (!track.ok) return track
      return ok({ op: 'add_track', track: track.value })
    }
    case 'remove_track': {
      const trackId = parseId(input.trackId, 'trackId')
      return trackId.ok ? ok({ op: 'remove_track', trackId: trackId.value }) : trackId
    }
    case 'update_track': {
      const trackId = parseId(input.trackId, 'trackId')
      if (!trackId.ok) return trackId
      const op: Extract<CompositionOp, { op: 'update_track' }> = { op: 'update_track', trackId: trackId.value }
      if (input.name !== undefined) {
        if (typeof input.name !== 'string' || input.name.length > MOTION_LIMITS.MAX_NAME) return bad('name too long')
        op.name = input.name
      }
      if (input.muted !== undefined) {
        if (typeof input.muted !== 'boolean') return bad('muted must be a boolean')
        op.muted = input.muted
      }
      return ok(op)
    }
    case 'move_track': {
      const trackId = parseId(input.trackId, 'trackId')
      if (!trackId.ok) return trackId
      if (typeof input.index !== 'number' || !Number.isInteger(input.index)) return bad('index must be an integer')
      return ok({ op: 'move_track', trackId: trackId.value, index: input.index })
    }
    case 'set_camera': {
      const t = parseSeconds(input.t, 't', 0, duration)
      if (!t.ok) return t
      const op: Extract<CompositionOp, { op: 'set_camera' }> = { op: 'set_camera', t: t.value }
      for (const prop of CAMERA_PROPERTIES) {
        if (input[prop] !== undefined) {
          if (typeof input[prop] !== 'number' || !Number.isFinite(input[prop])) return bad(`${prop} must be a number`)
          op[prop] = input[prop] as number
        }
      }
      if (op.x === undefined && op.y === undefined && op.zoom === undefined && op.rotation === undefined) {
        return bad('set_camera needs at least one of x, y, zoom, rotation')
      }
      if (input.easing !== undefined) {
        const e = parseEasing(input.easing)
        if (!e) return bad('easing is not valid')
        op.easing = e
      }
      return ok(op)
    }
    case 'add_keyframe': {
      const trackId = parseId(input.trackId, 'trackId')
      if (!trackId.ok) return trackId
      const keyframe = parseKeyframe(input.keyframe, duration)
      if (!keyframe.ok) return keyframe
      return ok({ op: 'add_keyframe', trackId: trackId.value, keyframe: keyframe.value })
    }
    case 'update_keyframe': {
      const trackId = parseId(input.trackId, 'trackId')
      if (!trackId.ok) return trackId
      const keyframeId = parseId(input.keyframeId, 'keyframeId')
      if (!keyframeId.ok) return keyframeId
      const op: Extract<CompositionOp, { op: 'update_keyframe' }> = {
        op: 'update_keyframe',
        trackId: trackId.value,
        keyframeId: keyframeId.value,
      }
      if (input.t !== undefined) {
        const t = parseSeconds(input.t, 't', 0, duration)
        if (!t.ok) return t
        op.t = t.value
      }
      if (input.value !== undefined) {
        if (typeof input.value !== 'number' && typeof input.value !== 'string')
          return bad('value must be number|string')
        op.value = input.value
      }
      if (input.easing !== undefined) {
        const e = parseEasing(input.easing)
        if (!e) return bad('easing is not valid')
        op.easing = e
      }
      return ok(op)
    }
    case 'remove_keyframe': {
      const trackId = parseId(input.trackId, 'trackId')
      if (!trackId.ok) return trackId
      const keyframeId = parseId(input.keyframeId, 'keyframeId')
      return keyframeId.ok
        ? ok({ op: 'remove_keyframe', trackId: trackId.value, keyframeId: keyframeId.value })
        : keyframeId
    }
    case 'add_clip': {
      const trackId = parseId(input.trackId, 'trackId')
      if (!trackId.ok) return trackId
      const clip = parseClip(input.clip, duration)
      if (!clip.ok) return clip
      return ok({ op: 'add_clip', trackId: trackId.value, clip: clip.value })
    }
    case 'update_clip': {
      const trackId = parseId(input.trackId, 'trackId')
      if (!trackId.ok) return trackId
      const clipId = parseId(input.clipId, 'clipId')
      if (!clipId.ok) return clipId
      const op: Extract<CompositionOp, { op: 'update_clip' }> = {
        op: 'update_clip',
        trackId: trackId.value,
        clipId: clipId.value,
      }
      for (const f of ['start', 'duration', 'mediaStart', 'speed', 'gain', 'fadeIn', 'fadeOut'] as const) {
        if (input[f] !== undefined) {
          const n = parseSeconds(input[f], f, f === 'duration' ? 0.01 : 0, MOTION_LIMITS.MAX_DURATION_S)
          if (!n.ok) return n
          op[f] = n.value
        }
      }
      if (op.speed !== undefined && (op.speed < 0.25 || op.speed > 4)) {
        return bad('speed must be between 0.25 and 4')
      }
      if (input.muted !== undefined) {
        if (typeof input.muted !== 'boolean') return bad('muted must be a boolean')
        op.muted = input.muted
      }
      if (input.name !== undefined) {
        if (typeof input.name !== 'string' || input.name.length > MOTION_LIMITS.MAX_NAME) return bad('name too long')
        op.name = input.name
      }
      if (input.source !== undefined) {
        const source = parseClipSource(input.source)
        if (!source.ok) return source
        op.source = source.value
      }
      if (input.transition !== undefined) {
        if (input.transition === null) {
          op.transition = null
        } else {
          const transition = parseTransition(input.transition)
          if (!transition) return bad('transition is not valid')
          op.transition = transition
        }
      }
      return ok(op)
    }
    case 'remove_clip': {
      const trackId = parseId(input.trackId, 'trackId')
      if (!trackId.ok) return trackId
      const clipId = parseId(input.clipId, 'clipId')
      return clipId.ok ? ok({ op: 'remove_clip', trackId: trackId.value, clipId: clipId.value }) : clipId
    }
    case 'set_direction': {
      if (input.direction === null || input.direction === undefined) {
        return ok({ op: 'set_direction', direction: null })
      }
      const direction = parseDirection(input.direction)
      if (!direction) return bad('direction is not a valid Direction')
      return ok({ op: 'set_direction', direction })
    }
    case 'set_motion_blur': {
      if (input.motionBlur === null || input.motionBlur === undefined) {
        return ok({ op: 'set_motion_blur', motionBlur: null })
      }
      const motionBlur = parseMotionBlur(input.motionBlur)
      if (!motionBlur) return bad('motionBlur must be {shutter: 0..360, samples?: 2..64}')
      return ok({ op: 'set_motion_blur', motionBlur })
    }
    case 'add_effect': {
      const trackId = parseId(input.trackId, 'trackId')
      if (!trackId.ok) return trackId
      const effect = parseEffectInstance(input.effect)
      if (!effect.ok) return effect
      const op: Extract<CompositionOp, { op: 'add_effect' }> = {
        op: 'add_effect',
        trackId: trackId.value,
        effect: effect.value,
      }
      if (input.index !== undefined) {
        if (typeof input.index !== 'number' || !Number.isInteger(input.index) || input.index < 0) {
          return bad('index must be a non-negative integer')
        }
        op.index = input.index
      }
      return ok(op)
    }
    case 'update_effect': {
      const trackId = parseId(input.trackId, 'trackId')
      if (!trackId.ok) return trackId
      const effectId = parseId(input.effectId, 'effectId')
      if (!effectId.ok) return effectId
      const op: Extract<CompositionOp, { op: 'update_effect' }> = {
        op: 'update_effect',
        trackId: trackId.value,
        effectId: effectId.value,
      }
      if (input.enabled !== undefined) {
        if (typeof input.enabled !== 'boolean') return bad('enabled must be a boolean')
        op.enabled = input.enabled
      }
      if (input.params !== undefined) {
        if (!isRecord(input.params)) return bad('params must be an object')
        for (const [k, v] of Object.entries(input.params)) {
          if (typeof v !== 'number' && typeof v !== 'string' && typeof v !== 'boolean') {
            return bad(`params.${k} must be a number, string or boolean`)
          }
        }
        op.params = input.params as Record<string, number | string | boolean>
      }
      if (input.seed !== undefined) {
        if (typeof input.seed !== 'number' || !Number.isInteger(input.seed) || input.seed < 0) {
          return bad('seed must be a non-negative integer')
        }
        op.seed = input.seed
      }
      if (input.mix !== undefined) {
        if (typeof input.mix !== 'number' || !Number.isFinite(input.mix) || input.mix < 0 || input.mix > 1) {
          return bad('mix must be in [0, 1]')
        }
        op.mix = input.mix
      }
      if (input.blend !== undefined) {
        if (input.blend !== null && !BLEND_MODES.includes(input.blend as BlendMode)) {
          return bad(`blend must be one of ${BLEND_MODES.join(', ')}`)
        }
        op.blend = input.blend as BlendMode | null
      }
      return ok(op)
    }
    case 'remove_effect': {
      const trackId = parseId(input.trackId, 'trackId')
      if (!trackId.ok) return trackId
      const effectId = parseId(input.effectId, 'effectId')
      return effectId.ok ? ok({ op: 'remove_effect', trackId: trackId.value, effectId: effectId.value }) : effectId
    }
    case 'reorder_effects': {
      const trackId = parseId(input.trackId, 'trackId')
      if (!trackId.ok) return trackId
      if (!Array.isArray(input.effectIds) || input.effectIds.some((id) => typeof id !== 'string')) {
        return bad('effectIds must be an array of ids')
      }
      return ok({ op: 'reorder_effects', trackId: trackId.value, effectIds: input.effectIds as string[] })
    }
    case 'set_blend': {
      const trackId = parseId(input.trackId, 'trackId')
      if (!trackId.ok) return trackId
      if (input.blend !== null && input.blend !== undefined && !BLEND_MODES.includes(input.blend as BlendMode)) {
        return bad(`blend must be one of ${BLEND_MODES.join(', ')}`)
      }
      return ok({ op: 'set_blend', trackId: trackId.value, blend: (input.blend ?? null) as BlendMode | null })
    }
    case 'set_layer': {
      const trackId = parseId(input.trackId, 'trackId')
      if (!trackId.ok) return trackId
      if (input.layer === null || input.layer === undefined) {
        return ok({ op: 'set_layer', trackId: trackId.value, layer: null })
      }
      const layer = parseLayerSpec(input.layer)
      if (!layer.ok) return layer
      return ok({ op: 'set_layer', trackId: trackId.value, layer: layer.value })
    }
    case 'set_matte': {
      const trackId = parseId(input.trackId, 'trackId')
      if (!trackId.ok) return trackId
      if (input.matte === null || input.matte === undefined) {
        return ok({ op: 'set_matte', trackId: trackId.value, matte: null })
      }
      const matte = parseLayerMatte(input.matte)
      if (!matte.ok) return matte
      return ok({ op: 'set_matte', trackId: trackId.value, matte: matte.value })
    }
    case 'add_mask': {
      const trackId = parseId(input.trackId, 'trackId')
      if (!trackId.ok) return trackId
      const mask = parseLayerMask(input.mask)
      if (!mask.ok) return mask
      return ok({ op: 'add_mask', trackId: trackId.value, mask: mask.value })
    }
    case 'update_mask': {
      const trackId = parseId(input.trackId, 'trackId')
      if (!trackId.ok) return trackId
      const maskId = parseId(input.maskId, 'maskId')
      if (!maskId.ok) return maskId
      const mask = parseLayerMask(input.mask)
      if (!mask.ok) return mask
      return ok({ op: 'update_mask', trackId: trackId.value, maskId: maskId.value, mask: mask.value })
    }
    case 'remove_mask': {
      const trackId = parseId(input.trackId, 'trackId')
      if (!trackId.ok) return trackId
      const maskId = parseId(input.maskId, 'maskId')
      return maskId.ok ? ok({ op: 'remove_mask', trackId: trackId.value, maskId: maskId.value }) : maskId
    }
    case 'set_masks': {
      const trackId = parseId(input.trackId, 'trackId')
      if (!trackId.ok) return trackId
      if (input.masks === null || input.masks === undefined) {
        return ok({ op: 'set_masks', trackId: trackId.value, masks: null })
      }
      if (!Array.isArray(input.masks) || input.masks.length > 32) {
        return bad('masks must be an array of at most 32')
      }
      const masks: LayerMask[] = []
      const seen = new Set<string>()
      for (const raw of input.masks) {
        const mask = parseLayerMask(raw)
        if (!mask.ok) return mask
        if (seen.has(mask.value.id)) return bad(`duplicate mask id ${mask.value.id}`)
        seen.add(mask.value.id)
        masks.push(mask.value)
      }
      return ok({ op: 'set_masks', trackId: trackId.value, masks })
    }
    default:
      return bad(`unknown op "${input.op}"`)
  }
}

/* ---- applying ops ---- */

/**
 * Apply validated ops to a composition, all-or-nothing. Returns a new
 * composition object — `revision`/`updatedAt`/`updatedBy` are the caller's
 * to stamp. Pure and deterministic apart from the ids `set_camera` and
 * `add_track` mint when the caller didn't supply them.
 */
export function applyCompositionOps(comp: Composition, ops: readonly CompositionOp[]): ParseResult<Composition> {
  const next = structuredClone(comp)
  for (const op of ops) {
    const err = applyOp(next, op)
    if (err) return bad(err)
  }
  const body = parseCompositionBody({ ...next, tracks: next.tracks })
  if (!body.ok) return bad(body.error)
  return ok(next)
}

function findTrack(comp: Composition, trackId: string): MotionTrack | undefined {
  return comp.tracks.find((t) => t.id === trackId)
}

function applyOp(comp: Composition, op: CompositionOp): string | null {
  switch (op.op) {
    case 'set_meta': {
      if (op.duration !== undefined) comp.duration = op.duration
      if (op.fps !== undefined) comp.fps = op.fps
      if (op.width !== undefined) comp.width = op.width
      if (op.height !== undefined) comp.height = op.height
      if (op.posterTime !== undefined) comp.posterTime = op.posterTime
      /* keep every keyframe/clip inside the new duration */
      for (const track of comp.tracks) {
        for (const kf of track.keyframes ?? []) if (kf.t > comp.duration) return `keyframe ${kf.id} past new duration`
        for (const c of track.clips ?? [])
          if (c.start + c.duration > comp.duration + 1e-9) return `clip ${c.id} past new duration`
      }
      if (comp.posterTime !== undefined && comp.posterTime > comp.duration) return 'posterTime past duration'
      return null
    }
    case 'add_track': {
      if (comp.tracks.length >= MOTION_LIMITS.MAX_TRACKS) return `over ${MOTION_LIMITS.MAX_TRACKS} tracks`
      if (findTrack(comp, op.track.id)) return `track ${op.track.id} already exists`
      if (op.track.kind === 'camera' && comp.tracks.some((t) => t.kind === 'camera'))
        return 'a camera track already exists'
      /* one element track per element: a second lane for the same target
         would split its keyframes across two layers — the batch fails so a
         racing preset application retries instead of duplicating */
      if (
        op.track.kind === 'element' &&
        op.track.elementId !== undefined &&
        comp.tracks.some(
          (t) => t.kind === 'element' && t.elementId === op.track.elementId && t.frameId === op.track.frameId,
        )
      )
        return `element ${op.track.elementId} already has a track`
      /* only camera, adjustment and element stacks reach the renderer — an
         effect stack, blend or layer spec on another kind would sit in the
         model undrawn, so the write is refused rather than stored silently */
      if (
        op.track.kind !== 'camera' &&
        op.track.kind !== 'adjustment' &&
        op.track.kind !== 'element' &&
        op.track.effects?.length
      )
        return `effects only draw on camera, adjustment and element tracks, not ${op.track.kind} tracks`
      if (op.track.blend != null && op.track.kind !== 'element')
        return `track blend only draws on element tracks, not ${op.track.kind} tracks`
      if ((op.track.layer != null || op.track.matte != null || op.track.masks != null) && op.track.kind !== 'element')
        return `layer, matte and masks only belong on element tracks, not ${op.track.kind} tracks`
      comp.tracks.push(op.track)
      return null
    }
    case 'remove_track': {
      const i = comp.tracks.findIndex((t) => t.id === op.trackId)
      if (i < 0) return `no track ${op.trackId}`
      comp.tracks.splice(i, 1)
      return null
    }
    case 'update_track': {
      const track = findTrack(comp, op.trackId)
      if (!track) return `no track ${op.trackId}`
      if (op.name !== undefined) track.name = op.name
      if (op.muted !== undefined) track.muted = op.muted
      return null
    }
    case 'move_track': {
      const i = comp.tracks.findIndex((t) => t.id === op.trackId)
      if (i < 0) return `no track ${op.trackId}`
      if (op.index < 0 || op.index >= comp.tracks.length) return `index ${op.index} out of range`
      const [track] = comp.tracks.splice(i, 1)
      comp.tracks.splice(op.index, 0, track!)
      return null
    }
    case 'set_camera': {
      let track = comp.tracks.find((t) => t.kind === 'camera')
      if (!track) {
        track = { id: newMotionId(), kind: 'camera', name: 'Camera', keyframes: [] }
        comp.tracks.unshift(track)
      }
      const keyframes = (track.keyframes ??= [])
      for (const prop of CAMERA_PROPERTIES) {
        const value = op[prop]
        if (value === undefined) continue
        const existing = keyframes.find((k) => k.property === prop && Math.abs(k.t - op.t) < 1e-6)
        if (existing) {
          existing.value = value
          if (op.easing) existing.easing = op.easing
        } else {
          keyframes.push({ id: newMotionId(), property: prop, t: op.t, value, easing: op.easing ?? { type: 'linear' } })
        }
      }
      keyframes.sort((a, b) => a.t - b.t || a.property.localeCompare(b.property))
      return null
    }
    case 'add_keyframe': {
      const track = findTrack(comp, op.trackId)
      if (!track) return `no track ${op.trackId}`
      if (track.kind === 'camera' && !isCameraProperty(op.keyframe.property) && !isFxProperty(op.keyframe.property)) {
        return `camera keyframe property must be one of ${CAMERA_PROPERTIES.join(', ')} or fx:<id>.<param>`
      }
      const keyframes = (track.keyframes ??= [])
      if (keyframes.length >= MOTION_LIMITS.MAX_KEYFRAMES_PER_TRACK) return 'too many keyframes'
      if (keyframes.some((k) => k.id === op.keyframe.id)) return `keyframe ${op.keyframe.id} already exists`
      keyframes.push(op.keyframe)
      keyframes.sort((a, b) => a.t - b.t)
      return null
    }
    case 'update_keyframe': {
      const track = findTrack(comp, op.trackId)
      const kf = track?.keyframes?.find((k) => k.id === op.keyframeId)
      if (!track || !kf) return `no keyframe ${op.keyframeId}`
      if (op.t !== undefined) kf.t = op.t
      if (op.value !== undefined) kf.value = op.value
      if (op.easing !== undefined) kf.easing = op.easing
      track.keyframes!.sort((a, b) => a.t - b.t)
      return null
    }
    case 'remove_keyframe': {
      const track = findTrack(comp, op.trackId)
      const i = track?.keyframes?.findIndex((k) => k.id === op.keyframeId) ?? -1
      if (!track || i < 0) return `no keyframe ${op.keyframeId}`
      track.keyframes!.splice(i, 1)
      return null
    }
    case 'add_clip': {
      const track = findTrack(comp, op.trackId)
      if (!track) return `no track ${op.trackId}`
      const err = clipAllowed(track, op.clip)
      if (err) return err
      const clips = (track.clips ??= [])
      if (clips.length >= MOTION_LIMITS.MAX_CLIPS_PER_TRACK) return 'too many clips'
      if (clips.some((c) => c.id === op.clip.id)) return `clip ${op.clip.id} already exists`
      if (op.clip.start + op.clip.duration > comp.duration + 1e-9) return 'clip ends past the composition duration'
      clips.push(op.clip)
      clips.sort((a, b) => a.start - b.start)
      return null
    }
    case 'update_clip': {
      const track = findTrack(comp, op.trackId)
      const clip = track?.clips?.find((c) => c.id === op.clipId)
      if (!track || !clip) return `no clip ${op.clipId}`
      if (op.start !== undefined) clip.start = op.start
      if (op.duration !== undefined) clip.duration = op.duration
      if (op.mediaStart !== undefined) clip.mediaStart = op.mediaStart
      if (op.speed !== undefined) clip.speed = op.speed
      if (op.gain !== undefined) clip.gain = op.gain
      if (op.fadeIn !== undefined) clip.fadeIn = op.fadeIn
      if (op.fadeOut !== undefined) clip.fadeOut = op.fadeOut
      if (op.muted !== undefined) clip.muted = op.muted
      if (op.name !== undefined) clip.name = op.name
      if (op.source !== undefined) {
        const err = clipAllowed(track, { ...clip, source: op.source })
        if (err) return err
        clip.source = op.source
      }
      if (op.transition !== undefined) {
        if (op.transition === null) delete clip.transition
        else clip.transition = op.transition
      }
      if (clip.start + clip.duration > comp.duration + 1e-9) return 'clip ends past the composition duration'
      track.clips!.sort((a, b) => a.start - b.start)
      return null
    }
    case 'remove_clip': {
      const track = findTrack(comp, op.trackId)
      const i = track?.clips?.findIndex((c) => c.id === op.clipId) ?? -1
      if (!track || i < 0) return `no clip ${op.clipId}`
      track.clips!.splice(i, 1)
      return null
    }
    case 'set_direction': {
      if (op.direction === null) delete comp.direction
      else comp.direction = op.direction
      return null
    }
    case 'set_motion_blur': {
      if (op.motionBlur === null) delete comp.motionBlur
      else comp.motionBlur = op.motionBlur
      return null
    }
    case 'add_effect': {
      const track = findTrack(comp, op.trackId)
      if (!track) return `no track ${op.trackId}`
      if (track.kind !== 'camera' && track.kind !== 'adjustment' && track.kind !== 'element')
        return `effects only draw on camera, adjustment and element tracks, not ${track.kind} tracks`
      const effects = (track.effects ??= [])
      if (effects.length >= 20) return 'too many effects on the track'
      if (effects.some((e) => e.id === op.effect.id)) return `effect ${op.effect.id} already exists`
      const index = op.index === undefined ? effects.length : Math.min(op.index, effects.length)
      effects.splice(index, 0, op.effect)
      return null
    }
    case 'update_effect': {
      const track = findTrack(comp, op.trackId)
      const effect = track?.effects?.find((e) => e.id === op.effectId)
      if (!track || !effect) return `no effect ${op.effectId}`
      if (op.enabled !== undefined) effect.enabled = op.enabled
      if (op.params !== undefined) {
        const specError = effectSpec(effect.fx)?.validate(op.params)
        if (specError) return specError
        effect.params = { ...effect.params, ...op.params }
      }
      if (op.seed !== undefined) effect.seed = op.seed
      if (op.mix !== undefined) effect.mix = op.mix
      if (op.blend !== undefined) {
        if (op.blend === null) delete effect.blend
        /* per-effect blend is parsed but the GL pass draws only `mix` —
           setting one would silently do nothing, so it is refused */
        else return 'effect blend is not drawn yet'
      }
      return null
    }
    case 'remove_effect': {
      const track = findTrack(comp, op.trackId)
      const i = track?.effects?.findIndex((e) => e.id === op.effectId) ?? -1
      if (!track || i < 0) return `no effect ${op.effectId}`
      track.effects!.splice(i, 1)
      if (track.keyframes?.some((kf) => isFxProperty(kf.property))) {
        /* fx lanes pointing at the removed instance dangle — lint MO-13
           reports them rather than silently rewriting the timeline */
      }
      return null
    }
    case 'reorder_effects': {
      const track = findTrack(comp, op.trackId)
      if (!track) return `no track ${op.trackId}`
      if (!Array.isArray(op.effectIds)) return 'effectIds must be an array of effect ids'
      const effects = track.effects ?? []
      const ids = new Set(op.effectIds)
      if (ids.size !== op.effectIds.length) return 'duplicate ids in effectIds'
      if (effects.length !== ids.size || effects.some((e) => !ids.has(e.id))) {
        return 'effectIds must name every effect on the track exactly once'
      }
      const byId = new Map(effects.map((e) => [e.id, e]))
      track.effects = op.effectIds.map((id) => byId.get(id)!)
      return null
    }
    case 'set_blend': {
      const track = findTrack(comp, op.trackId)
      if (!track) return `no track ${op.trackId}`
      /* only element tracks composite a blend — writing one anywhere else
         would be a silent no-op; a null clear still scrubs a legacy value */
      if (track.kind !== 'element' && op.blend !== null)
        return `track blend only draws on element tracks, not ${track.kind} tracks`
      if (op.blend === null) delete track.blend
      else track.blend = op.blend
      return null
    }
    case 'set_layer': {
      const track = findTrack(comp, op.trackId)
      if (!track) return `no track ${op.trackId}`
      if (track.kind !== 'element' && op.layer !== null)
        return `layers only exist on element tracks, not ${track.kind} tracks`
      if (op.layer === null) delete track.layer
      /* the op carries a partial spec — the given fields merge into what is
         stored, so `set_layer { pad: 30 }` does not erase an existing
         `mode: 'on'`; `null` clears the whole spec */
      else track.layer = { ...track.layer, ...op.layer }
      return null
    }
    case 'set_matte': {
      const track = findTrack(comp, op.trackId)
      if (!track) return `no track ${op.trackId}`
      if (track.kind !== 'element' && op.matte !== null)
        return `mattes only exist on element tracks, not ${track.kind} tracks`
      if (op.matte === null) delete track.matte
      else track.matte = op.matte
      return null
    }
    case 'add_mask': {
      const track = findTrack(comp, op.trackId)
      if (!track) return `no track ${op.trackId}`
      if (track.kind !== 'element') return `masks only exist on element tracks, not ${track.kind} tracks`
      const masks = (track.masks ??= [])
      if (masks.length >= 32) return 'too many masks on the track'
      if (masks.some((m) => m.id === op.mask.id)) return `mask ${op.mask.id} already exists`
      masks.push(op.mask)
      return null
    }
    case 'update_mask': {
      const track = findTrack(comp, op.trackId)
      const i = track?.masks?.findIndex((m) => m.id === op.maskId) ?? -1
      if (!track || i < 0) return `no mask ${op.maskId}`
      /* the mask's id is its address — a rename is remove+add */
      track.masks![i] = { ...op.mask, id: op.maskId }
      return null
    }
    case 'remove_mask': {
      const track = findTrack(comp, op.trackId)
      const i = track?.masks?.findIndex((m) => m.id === op.maskId) ?? -1
      if (!track || i < 0) return `no mask ${op.maskId}`
      track.masks!.splice(i, 1)
      return null
    }
    case 'set_masks': {
      const track = findTrack(comp, op.trackId)
      if (!track) return `no track ${op.trackId}`
      if (track.kind !== 'element' && op.masks !== null)
        return `masks only exist on element tracks, not ${track.kind} tracks`
      if (op.masks === null) delete track.masks
      else track.masks = op.masks
      return null
    }
  }
}

/** which clip sources a track kind accepts */
function clipAllowed(track: MotionTrack, clip: MotionClip): string | null {
  const type = clip.source.type
  switch (track.kind) {
    case 'clip':
      return type === 'frame' || type === 'library' || type === 'asset' ? null : `clip track cannot take a ${type} clip`
    case 'audio':
      return type === 'asset' ? null : 'audio tracks only take asset clips'
    case 'caption':
      return type === 'caption' ? null : 'caption tracks only take caption clips'
    case 'adjustment':
      return type === 'adjustment' ? null : 'adjustment tracks only take adjustment clips'
    case 'camera':
    case 'element':
      return `${track.kind} tracks do not take clips`
  }
}

/* ---- helpers ---- */

/**
 * Finite numeric coercion shared by the CSS writer and the layer matrix:
 * a resolved lane value may arrive as a numeric string ("10"), which both
 * readers must honour identically — a matrix that only accepts `number`
 * would silently drop a transform the raster does apply.
 */
export const motionNumber = (v: number | string | undefined): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/** the key element state is indexed under: `frameId/elementId` */
export const elementKey = (frameId: string, elementId: string): string => `${frameId}/${elementId}`

/**
 * Point a copied composition at the copied frames: page/canvas duplication
 * remaps `frameId` targets (element tracks, frame clips) through the copy's
 * id map and leaves references to frames outside it alone.
 */
export function remapCompositionRefs<T extends Pick<Composition, 'tracks'>>(
  comp: T,
  frameIds: ReadonlyMap<string, string>,
): T {
  const remap = (id: string | undefined) => (id ? (frameIds.get(id) ?? id) : id)
  return {
    ...comp,
    tracks: comp.tracks.map((track) => ({
      ...track,
      frameId: remap(track.frameId),
      clips: track.clips?.map((clip) =>
        clip.source.type === 'frame'
          ? { ...clip, source: { ...clip.source, frameId: remap(clip.source.frameId)! } }
          : clip,
      ),
    })),
  }
}

export const newComposition = (input: {
  canvasId: string
  pageId: string
  body: CompositionBody
  updatedBy: string
  now: number
}): Composition => ({
  id: newMotionId(),
  canvasId: input.canvasId,
  pageId: input.pageId,
  duration: input.body.duration,
  fps: input.body.fps,
  width: input.body.width,
  height: input.body.height,
  ...(input.body.posterTime !== undefined ? { posterTime: input.body.posterTime } : {}),
  tracks: input.body.tracks,
  ...(input.body.direction !== undefined ? { direction: input.body.direction } : {}),
  ...(input.body.motionBlur !== undefined ? { motionBlur: input.body.motionBlur } : {}),
  revision: 1,
  createdAt: input.now,
  updatedAt: input.now,
  updatedBy: input.updatedBy,
})

/* ---- storyboard → composition (animate_storyboard) ----
 * The deterministic half of "turn this page into a film": the Diazo Agent
 * reads the brief, calls this builder through the tool, then refines with
 * patch ops. Ordering is reading order — top-to-bottom rows, left-to-right
 * inside a row. */

export interface StoryboardFrame {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export interface StoryboardShot {
  frameId: string
  t: number
  duration: number
}

/**
 * Frames in reading order: bin into rows by vertical overlap, rows sorted by
 * their top edge, each row sorted left to right.
 */
export function storyboardOrder(frames: readonly StoryboardFrame[]): StoryboardFrame[] {
  const sorted = [...frames].sort((a, b) => a.y - b.y || a.x - b.x)
  const rows: { top: number; bottom: number; frames: StoryboardFrame[] }[] = []
  for (const f of sorted) {
    const cy = f.y + f.height / 2
    const row = rows.find((r) => cy >= r.top && cy <= r.bottom)
    if (row) {
      row.frames.push(f)
      row.top = Math.min(row.top, f.y)
      row.bottom = Math.max(row.bottom, f.y + f.height)
    } else {
      rows.push({ top: f.y, bottom: f.y + f.height, frames: [f] })
    }
  }
  const out: StoryboardFrame[] = []
  for (const row of rows.sort((a, b) => a.top - b.top)) {
    out.push(...row.frames.sort((a, b) => a.x - b.x))
  }
  return out
}

/**
 * The camera state that frames `frame` inside the output rect, with `margin`
 * of breathing room around it (1 = exact fit).
 */
export function fitCameraToFrame(
  frame: StoryboardFrame,
  outWidth: number,
  outHeight: number,
  margin = 1.08,
): { x: number; y: number; zoom: number; rotation: number } {
  const zoom = Math.min(outWidth / (frame.width * margin), outHeight / (frame.height * margin))
  return { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2, zoom, rotation: 0 }
}

export interface StoryboardOptions {
  frames: readonly StoryboardFrame[]
  /** output size and rate — the composition's */
  width: number
  height: number
  fps: number
  /** seconds per shot; default 3 */
  shotSeconds?: number
  /** breathing room around each shot's frame; default 1.08 */
  margin?: number
  /** the director's treatment — beats set per-shot seconds and how each shot
   *  hands over to the next, and the direction rides the composition body so
   *  the film keeps its intent */
  direction?: Direction
}

export interface StoryboardShot {
  frameId: string
  t: number
  duration: number
  /** how this shot hands over to the next ('cut' when absent) */
  transition?: string
}

/** transition names a DirectionBeat carries → how the camera gets to the
 *  next shot. Returns the handover window in seconds and the eased curve;
 *  null means a hard cut (the camera holds, then jumps). */
function beatTransition(name: string | undefined): { tr: number; easing: MotionEasing } | null {
  switch (name) {
    case undefined:
    case 'cut':
      return null
    case 'move':
    case 'wipe':
    case 'shared-element':
      return { tr: 0.6, easing: { type: 'cubic-bezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1 } }
    case 'push':
    case 'zoom':
      return { tr: 0.8, easing: { type: 'cubic-bezier', x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 } }
    case 'whip':
      return { tr: 0.3, easing: { type: 'cubic-bezier', x1: 0.7, y1: 0, x2: 0.3, y2: 1 } }
    case 'fade':
    case 'dissolve':
      return { tr: 0.9, easing: { type: 'cubic-bezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1 } }
    default:
      /* an unknown name reads as a cut rather than a guess */
      return null
  }
}

/**
 * Build the timeline a page of frames implies: one shot per frame in reading
 * order, a camera track that cuts from shot to shot (`hold` easings) unless
 * the direction's beats say otherwise. With beats, each shot takes its
 * beat's `seconds` — durations stop being uniform — and a non-cut handover
 * holds the pose for most of the shot then eases into the next frame inside
 * the handover window.
 */
export function buildStoryboard(opts: StoryboardOptions): { body: CompositionBody; shots: StoryboardShot[] } {
  const shotSeconds = opts.shotSeconds ?? 3
  const ordered = storyboardOrder(opts.frames)
  const beats = opts.direction?.beats
  const shots: StoryboardShot[] = []
  const keyframes: MotionKeyframe[] = []
  const pose = (t: number, cam: { x: number; y: number; zoom: number; rotation: number }, easing: MotionEasing) => {
    for (const prop of CAMERA_PROPERTIES) {
      keyframes.push({ id: newMotionId(), property: prop, t, value: cam[prop], easing })
    }
  }
  const cams = ordered.map((frame) => fitCameraToFrame(frame, opts.width, opts.height, opts.margin ?? 1.08))
  let cursor = 0
  ordered.forEach((frame, i) => {
    const duration = beats?.[i]?.seconds ?? shotSeconds
    const t = cursor
    cursor += duration
    const handover = i < ordered.length - 1 ? beatTransition(beats?.[i]?.transition) : null
    shots.push({ frameId: frame.id, t, duration, transition: handover ? beats?.[i]?.transition : undefined })
    pose(t, cams[i]!, { type: 'hold' })
    if (handover) {
      const next = cams[i + 1]!
      const nextDuration = beats?.[i + 1]?.seconds ?? shotSeconds
      const tr = Math.min(handover.tr, duration * 0.45, nextDuration * 0.45)
      if (tr >= 0.05) {
        /* hold most of the shot, travel the last tr seconds into the next
           pose — 'push' lands slightly tighter, 'fade' drifts through a
           gentle dolly, the honest camera-film shapes of those moves */
        const land =
          beats?.[i]?.transition === 'push' || beats?.[i]?.transition === 'zoom'
            ? { ...next, zoom: next.zoom * 1.08 }
            : beats?.[i]?.transition === 'fade' || beats?.[i]?.transition === 'dissolve'
              ? { ...next, zoom: next.zoom * 1.03 }
              : next
        pose(t + duration - tr, cams[i]!, handover.easing)
        /* the eased segment lands exactly on the next shot's start — writing
           the landing pose into the next shot keeps its hold consistent */
        cams[i + 1] = land
      }
    }
  })
  const duration = Math.max(cursor, MOTION_LIMITS.MIN_DURATION_S)
  const track: MotionTrack = { id: newMotionId(), kind: 'camera', name: 'Camera', keyframes }
  return {
    body: {
      duration,
      fps: opts.fps,
      width: opts.width,
      height: opts.height,
      tracks: [track],
      direction: opts.direction,
    },
    shots,
  }
}
