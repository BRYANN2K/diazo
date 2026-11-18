/**
 * server/motionProTools.ts — the motion-pro tool logic, shared by the MCP
 * tools (server/mcp.ts) and the resident agent (server/resident.ts), same
 * contract as motionTools.ts: the caller has gated the canvas, each
 * function answers `{ ok: true, data }` / `{ ok: false, error }`.
 *
 * P0 — the director kit: the composition's Direction, the preset tools that
 * write ordinary editable keyframes and clips, the scene snapshot and the
 * two checks (check_scene, critique_scene) that let the agent see and
 * grade its own render.
 * P1 — the effect stack: registry listing, add/update/remove/reorder,
 * looks, blend modes, the filmic shutter.
 */

import * as actions from './actions.ts'
import { store } from './store.ts'
import { resetCritiques } from './motionSnapshot.ts'
import { elementHtml } from '../shared/motionLint.ts'
import { elementText, expandTextAnimator } from '../shared/motionText.ts'
import { cameraPreset, CAMERA_PRESETS, isCameraPreset, cameraPresetNote } from '../shared/motionPresets.ts'
import { frameStateAt } from '../shared/motionRuntime.ts'
import { effectSpec, MOTION_EFFECTS } from '../shared/motionFx.ts'
import { MOTION_LOOKS, lookEffects } from '../shared/motionLooks.ts'
import {
  BLEND_MODES,
  fitCameraToFrame,
  MOTION_BLOCK_ATTR,
  MOTION_LIMITS,
  newMotionId,
  parseEasing,
  parseMotionBlock,
  TEXT_ANIMATOR_PRESETS,
  TEXT_SPLITS,
  TRANSITION_DIRECTIONS,
  TRANSITION_KINDS,
  type Composition,
  type CompositionOp,
  type Direction,
  type EffectInstance,
  type FrameTextAnimator,
  type MotionEasing,
  type MotionKeyframe,
  type MotionTrack,
  type MotionTransition,
  type TextOrder,
  type TextSplit,
} from '../shared/motion.ts'
import { planLayers, type FramePlan } from '../shared/motionLayers.ts'
import {
  ELEMENT_PRESET_MAX_DURATION,
  elementPreset,
  elementPresetList,
  elementPresetSpec,
  isElementPreset,
  staggerOffsets,
  type StaggerOptions,
} from '../shared/motionElementPresets.ts'
import { canvasPages } from '../shared/pages.ts'
import type { Actor, Canvas } from '../shared/types.ts'

type Outcome = { ok: true; data: unknown } | { ok: false; error: string }
const ok = <T>(data: T) => ({ ok: true as const, data })
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })

function pageOn(canvas: Canvas, pageId: string): boolean {
  return canvasPages(canvas).some((p) => p.id === pageId)
}

function compOf(canvas: Canvas, pageId: string) {
  if (!pageOn(canvas, pageId)) return fail(`no page ${pageId} on this canvas`)
  const comp = store.getComposition(canvas.id, pageId)
  if (!comp) {
    return fail(`page ${pageId} has no composition — create one with set_composition or animate_storyboard`)
  }
  return comp
}

const num = (v: unknown, name: string, min: number, max: number): number | { error: string } => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return { error: `${name} must be a number` }
  if (v < min || v > max) return { error: `${name} must be in [${min}, ${max}]` }
  return v
}

/* ---- the director's intent ---- */

export function getDirection(canvas: Canvas, pageId: string): Outcome {
  const comp = compOf(canvas, pageId)
  if ('error' in comp) return comp
  return ok({ direction: comp.direction ?? null })
}

/** Persist the treatment on the composition; `null` clears it. The write is
 *  an ordinary ops patch, so peers see it land like any timeline edit. */
export function setDirection(canvas: Canvas, pageId: string, direction: unknown, actor: Actor): Outcome {
  const comp = compOf(canvas, pageId)
  if ('error' in comp) return comp
  const applied = actions.patchComposition(
    canvas.id,
    pageId,
    [{ op: 'set_direction', direction: (direction ?? null) as Direction | null }],
    actor,
  )
  if (!applied.ok) return fail(applied.error ?? 'direction rejected')
  /* a new treatment is a new run: the critique pass budget restarts */
  resetCritiques(canvas.id, pageId)
  return ok({ composition: applied.composition, direction: applied.composition.direction ?? null })
}

/* ---- the vocabulary: what the preset tools can write ---- */

export function listMotionPresets(): Outcome {
  return ok({
    camera_presets: CAMERA_PRESETS.map((id) => ({ id, note: cameraPresetNote(id) })),
    transitions: TRANSITION_KINDS.map((kind) => ({
      kind,
      directions: kind === 'push' || kind === 'wipe' ? TRANSITION_DIRECTIONS : [],
    })),
    text_animators: TEXT_ANIMATOR_PRESETS,
    text_splits: TEXT_SPLITS,
    blend_modes: BLEND_MODES,
  })
}

/* ---- apply_camera_preset ----
 * A preset writes ordinary camera keyframes — nothing opaque: the agent or
 * the editor keeps editing every value afterwards. `from` is the camera at
 * `t` (so a preset composes onto what's already there) unless frame_id asks
 * to re-frame a shot first. */

export function applyCameraPreset(
  canvas: Canvas,
  pageId: string,
  input: {
    preset?: string
    t?: number
    duration?: number
    amount?: number
    frame_id?: string
    seed?: number
    frequency?: number
    easing?: unknown
  },
  actor: Actor,
): Outcome {
  const comp = compOf(canvas, pageId)
  if ('error' in comp) return comp
  if (!isCameraPreset(input.preset)) {
    return fail(`preset must be one of ${CAMERA_PRESETS.join(', ')}`)
  }
  const t = input.t ?? 0
  if (!Number.isFinite(t) || t < 0 || t > comp.duration) {
    return fail(`t must be within the film [0, ${comp.duration}]`)
  }
  const duration = input.duration ?? 1
  if (!Number.isFinite(duration) || duration <= 0) return fail('duration must be a positive number of seconds')
  const end = Math.min(t + duration, comp.duration)
  let easing: MotionEasing | undefined
  if (input.easing !== undefined) {
    const parsed = parseEasing(input.easing)
    if (!parsed) return fail('easing is not valid')
    easing = parsed
  }
  /* the move's origin: a re-frame of the named shot, else the camera the
     timeline already has at t, else the page-wide view */
  let from = frameStateAt(comp, t).camera
  let frameRect: { id: string; x: number; y: number; width: number; height: number } | undefined
  if (input.frame_id !== undefined) {
    const frame = store.getFrame(input.frame_id)
    if (!frame || frame.pageId !== pageId) return fail(`no frame ${input.frame_id} on page ${pageId}`)
    frameRect = { id: frame.id, x: frame.x, y: frame.y, width: frame.width, height: frame.height }
    from = fitCameraToFrame(frameRect, comp.width, comp.height)
  }
  const keyframes = cameraPreset(input.preset, {
    t,
    duration: end - t,
    from: from ?? { x: 0, y: 0, zoom: 1, rotation: 0 },
    frame: frameRect,
    amount: input.amount,
    seed: input.seed,
    frequency: input.frequency,
    easing,
  })
  const cameraTrack = comp.tracks.find((track) => track.kind === 'camera')
  const ops: CompositionOp[] = cameraTrack
    ? keyframes.map((keyframe) => ({ op: 'add_keyframe', trackId: cameraTrack.id, keyframe }))
    : [{ op: 'add_track', track: { id: newMotionId(), kind: 'camera', name: 'Camera', keyframes } }]
  const applied = actions.patchComposition(canvas.id, pageId, ops, actor)
  if (!applied.ok) return fail(applied.error ?? 'preset rejected')
  return ok({
    composition: applied.composition,
    preset: input.preset,
    keyframes: keyframes.length,
    window: { t, end },
    note: `${input.preset} wrote ${keyframes.length} editable keyframes — tune any of them with set_composition ops.`,
  })
}

/* ---- apply_transition ----
 * Transitions hang on the incoming clip; 'cut' clears the field. */

export function applyTransition(
  canvas: Canvas,
  pageId: string,
  input: {
    track_id?: string
    clip_id?: string
    kind?: string
    duration?: number
    direction?: string
    token?: string
    easing?: unknown
  },
  actor: Actor,
): Outcome {
  const comp = compOf(canvas, pageId)
  if ('error' in comp) return comp
  const track = comp.tracks.find((t) => t.id === input.track_id)
  if (!track) return fail(`no track ${input.track_id}`)
  const clip = track.clips?.find((c) => c.id === input.clip_id)
  if (!clip) return fail(`no clip ${input.clip_id} on track ${input.track_id}`)
  if (!TRANSITION_KINDS.includes(input.kind as never)) {
    return fail(`kind must be one of ${TRANSITION_KINDS.join(', ')}`)
  }
  let transition: MotionTransition | null = null
  if (input.kind !== 'cut') {
    if (input.duration === undefined) return fail('a non-cut transition needs duration (seconds of overlap)')
    const d = num(input.duration, 'duration', 0.05, Math.min(5, clip.duration))
    if (typeof d !== 'number') return fail(d.error)
    transition = { kind: input.kind as MotionTransition['kind'], duration: d }
    if (input.direction !== undefined) {
      if (!TRANSITION_DIRECTIONS.includes(input.direction as never)) {
        return fail(`direction must be one of ${TRANSITION_DIRECTIONS.join(', ')}`)
      }
      transition.direction = input.direction as MotionTransition['direction']
    }
    if (input.token !== undefined) {
      if (typeof input.token !== 'string' || input.token.length > 60) return fail('token must be a --dur-* name')
      transition.token = input.token
    }
    if (input.easing !== undefined) {
      const parsed = parseEasing(input.easing)
      if (!parsed) return fail('easing is not valid')
      transition.easing = parsed
    }
  }
  const applied = actions.patchComposition(
    canvas.id,
    pageId,
    [{ op: 'update_clip', trackId: track.id, clipId: clip.id, transition }],
    actor,
  )
  if (!applied.ok) return fail(applied.error ?? 'transition rejected')
  return ok({ composition: applied.composition, clip: { ...clip, transition } })
}

/* ---- apply_text_animation ----
 * The animator spec lands in the frame's data-doop-motion block — the same
 * place a human's text animator lives — with data-doop-split stamped on the
 * element. The runtime expands it deterministically, so preview, desktop
 * and server renders all see the same units. */

const MOTION_SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi

export async function applyTextAnimation(
  canvas: Canvas,
  pageId: string,
  input: {
    frame_id?: string
    element_id?: string
    preset?: string
    split?: string
    start?: number
    duration?: number
    stagger?: number
    order?: string
    seed?: number
  },
  actor: Actor,
): Promise<Outcome> {
  if (!pageOn(canvas, pageId)) return fail(`no page ${pageId} on this canvas`)
  const loaded = (await store.load(canvas.id)) ?? canvas
  const frame = store.getFrame(input.frame_id ?? '')
  if (!frame || frame.pageId !== pageId) return fail(`no frame ${input.frame_id} on page ${pageId}`)
  if (!loaded.frames.some((f) => f.id === frame.id)) return fail(`no frame ${input.frame_id} on page ${pageId}`)
  /* a stream or reveal is writing this frame live — stamping on top of it
     would silently lose one side's bytes */
  if (actions.isFrameStreaming(frame.id)) return fail(`frame ${frame.id} is mid-stream — try again once it settles`)
  const elementId = input.element_id
  if (!elementId) return fail('element_id is required')
  const subtree = elementHtml(frame.html, elementId)
  if (!subtree) return fail(`no element ${elementId} in frame ${frame.id}`)
  if (!TEXT_ANIMATOR_PRESETS.includes(input.preset as never)) {
    return fail(`preset must be one of ${TEXT_ANIMATOR_PRESETS.join(', ')}`)
  }
  /* the element's own split attribute wins over the default; a split it
     doesn't carry gets stamped with the animator */
  const attrSplit = /data-doop-split="(line|word|char)"/.exec(subtree)?.[1]
  const split = (input.split ?? attrSplit ?? 'word') as string
  if (!TEXT_SPLITS.includes(split as TextSplit)) return fail(`split must be one of ${TEXT_SPLITS.join(', ')}`)
  const text = elementText(frame.html, elementId)
  if (!text?.trim()) return fail(`element ${elementId} has no flat text to animate`)

  const start = num(input.start ?? 0, 'start', 0, Number.MAX_SAFE_INTEGER)
  if (typeof start !== 'number') return fail(start.error)
  const duration = num(input.duration ?? 0.6, 'duration', 0, Number.MAX_SAFE_INTEGER)
  if (typeof duration !== 'number' || duration <= 0) return fail('duration must be a positive number of seconds')
  const stagger = num(input.stagger ?? 0.04, 'stagger', 0, Number.MAX_SAFE_INTEGER)
  if (typeof stagger !== 'number') return fail(stagger.error)

  const candidate: FrameTextAnimator = {
    el: elementId,
    split: split as TextSplit,
    preset: input.preset as FrameTextAnimator['preset'],
    start,
    duration,
    stagger,
  }
  if (input.order !== undefined) candidate.order = input.order as TextOrder
  if (input.seed !== undefined) candidate.seed = input.seed as number
  /* the same validator the runtime's block parser uses — on the resident
     path the fields arrive untyped, so nothing reaches the frame without
     passing parseTextAnimator's rules */
  const checked = parseMotionBlock(JSON.stringify({ v: 1, keyframes: [], animators: [candidate] }))
  const animator = checked?.animators?.[0]
  if (!animator) {
    return fail(
      'invalid animator — start must be ≥ 0, duration > 0, stagger ≥ 0, order forward|center|random, seed a non-negative integer',
    )
  }
  const expanded = expandTextAnimator(animator, text)
  if (expanded.units.length === 0) return fail(`the ${split} split produces no units on that text`)

  /* fold the animator into the frame's motion block — existing spec is
     kept, a missing block is created. Function replacers everywhere: a
     `$&`/`$$` inside the markup must not be read as a replacement pattern */
  let html = frame.html
  let block: { v: 1; keyframes: unknown[]; animators: FrameTextAnimator[] } = { v: 1, keyframes: [], animators: [] }
  let replaced = false
  html = html.replace(MOTION_SCRIPT_RE, (whole, attrs: string, body: string) => {
    if (replaced || !attrs.includes(MOTION_BLOCK_ATTR)) return whole
    const parsed = parseMotionBlock(body)
    if (parsed) block = { v: 1, keyframes: parsed.keyframes, animators: [...(parsed.animators ?? [])] }
    replaced = true
    block.animators.push(animator)
    return `<script type="application/json" ${MOTION_BLOCK_ATTR}>${JSON.stringify(block)}</script>`
  })
  if (!replaced) {
    block.animators.push(animator)
    const script = `<script type="application/json" ${MOTION_BLOCK_ATTR}>${JSON.stringify(block)}</script>`
    html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, () => `${script}</body>`) : html + script
  }
  /* stamp the split the animator needs (MO-12) unless the element has one */
  if (!attrSplit) {
    const openEnd = subtree.indexOf('>')
    const selfClosing = subtree[openEnd - 1] === '/'
    const stamped =
      subtree.slice(0, openEnd - (selfClosing ? 1 : 0)) + ` data-doop-split="${split}"` + subtree.slice(openEnd)
    html = html.replace(subtree, () => stamped)
  }
  /* an ordinary design write: a frame version in the history, a broadcast,
     and the agent's reveal/activity treatment like any other markup edit */
  const next = actions.updateFrame(frame.id, { html }, actor)
  if (!next) return fail('the frame is gone or mid-stream — try again')
  return ok({
    frame_id: frame.id,
    element_id: elementId,
    preset: animator.preset,
    split,
    units: expanded.units.length,
    first_unit_at: Math.min(...expanded.keyframes.map((k) => k.t)),
    last_unit_at: Math.max(...expanded.keyframes.map((k) => k.t)),
    note: 'The animator rides the frame’s data-doop-motion block — the split units render the same in preview, desktop and server renders.',
  })
}

/* ---- the effect stack (P1) ---- */

export function listMotionEffects(): Outcome {
  return ok({
    effects: MOTION_EFFECTS.map((fx) => ({
      id: fx.id,
      label: fx.label,
      family: fx.family,
      cost: fx.cost,
      alpha: fx.alpha,
      /* px the effect spreads past its input's edge at default params —
         the layer pad sums these */
      grow: fx.grow ? Math.ceil(fx.grow(fx.defaults())) : 0,
      /* where the stack draws: an element layer, the scene camera or an
         adjustment covering the film */
      scopes: ['element', 'camera', 'adjustment'],
      params: fx.params,
      ...(fx.gen ? { generates: true } : {}),
      /* luma matte and displacement map bind the layer's own picture on
         u_tex2 until instances can point at another element's texture —
         say so, or an agent expects a matte from another layer */
      ...(fx.needsInput ? { needs_input: true } : {}),
      ...(fx.selfMapped ? { self_mapped: true } : {}),
    })),
    blend_modes: BLEND_MODES,
    blend_use: BLEND_USE,
  })
}

/** one line each so an agent picks the mode that means what it wants */
const BLEND_USE: Record<string, string> = {
  normal: 'ordinary stacking — the default',
  multiply: 'darkens — shadows and ink on paper',
  screen: 'lightens — glows, light leaks, additive-feeling without clipping',
  overlay: 'contrast both ways — keeps blacks and whites',
  darken: 'keeps the darker channel per pixel',
  lighten: 'keeps the lighter channel per pixel',
  'color-dodge': 'brightens hard — blown-out light',
  'color-burn': 'darkens hard — deep scorched shadows',
  'hard-light': 'the layer lights or shades the base — a light source on it',
  'soft-light': 'gentle dodge+burn — ambient light',
  difference: 'absolute delta — inverts overlaps, alignment checks',
  exclusion: 'soft difference — lower-contrast inversion',
  add: 'linear add — true additive light, clips at 1',
  subtract: 'linear subtract — pulls the layer out of the base',
  divide: 'channel ratio — flat-fields the base',
  'linear-burn': 'additive darkening — heavy shadow',
  'vivid-light': 'hard dodge/burn by lightness — posterised light',
  'linear-light': 'linear burn/dodge by lightness — harsh light',
  'pin-light': 'swaps darks and lights around mid grey',
  'hard-mix': 'thresholds to pure primaries — flat posterise',
  hue: "keeps the layer's hue on the base's shading",
  saturation: "keeps the layer's saturation on the base's shading",
  color: "hue + saturation — colourizes the base's shading",
  luminosity: "keeps the layer's luminance on the base's colour",
  'darker-color': 'keeps the darker composite colour per pixel',
  'lighter-color': 'keeps the lighter composite colour per pixel',
}

/** effect ops share their plumbing: validate ids, patch, report. When a
 *  racing peer created the same element track between our read and the
 *  patch, the minted `add_track` refuses ("element already has a track") —
 *  fold the minted id onto the track that won the race and retry, so two
 *  concurrent first writes land on one track instead of duplicating. */
function effectPatch(canvas: Canvas, pageId: string, ops: CompositionOp[], actor: Actor): Outcome {
  const comp = compOf(canvas, pageId)
  if ('error' in comp) return comp
  let applied = actions.patchComposition(canvas.id, pageId, ops, actor)
  for (
    let attempt = 0;
    attempt < 2 && !applied.ok && /already exists|already has a track/.test(applied.error ?? '');
    attempt++
  ) {
    const fresh = store.getComposition(canvas.id, pageId)
    if (!fresh) return fail('the page has no composition — create one first')
    const remap = new Map<string, string>()
    const kept: CompositionOp[] = []
    for (const op of ops) {
      if (op.op === 'add_track' && op.track.kind === 'element' && op.track.elementId) {
        const existing = fresh.tracks.find(
          (t) => t.kind === 'element' && t.frameId === op.track.frameId && t.elementId === op.track.elementId,
        )
        if (existing) {
          remap.set(op.track.id, existing.id)
          continue
        }
      }
      kept.push(op)
    }
    if (remap.size === 0) break
    const remapped = kept.map((op) =>
      'trackId' in op && remap.has(op.trackId as string)
        ? ({ ...op, trackId: remap.get(op.trackId as string)! } as CompositionOp)
        : op,
    )
    applied = actions.patchComposition(canvas.id, pageId, remapped, actor)
  }
  if (!applied.ok) return fail(applied.error ?? 'rejected')
  return ok({ composition: applied.composition })
}

/** the kinds an effect stack draws on (element tracks join camera and
 *  adjustment in the layer compositor — motion-elements P0) */
const EFFECT_TRACK_KINDS = new Set(['camera', 'adjustment', 'element'])

/**
 * Resolve the track an element-addressed tool targets. `track_id` wins;
 * else `frame_id` + `element_id` find or — through the returned op —
 * create the element track. The frame's markup is checked so a typo'd
 * data-doop-id fails loudly instead of writing a dead lane.
 */
async function elementTrack(
  canvas: Canvas,
  pageId: string,
  comp: { tracks: { id: string; kind: string; frameId?: string; elementId?: string }[] },
  input: { track_id?: string; frame_id?: string; element_id?: string },
): Promise<
  { ok: true; trackId: string; elementTrack: boolean; create?: CompositionOp } | { ok: false; error: string }
> {
  if (input.track_id !== undefined) {
    const track = comp.tracks.find((t) => t.id === input.track_id)
    if (!track) return { ok: false, error: `no track ${input.track_id}` }
    return { ok: true, trackId: track.id, elementTrack: track.kind === 'element' }
  }
  if (!input.frame_id || !input.element_id) {
    return { ok: false, error: 'give track_id or frame_id + element_id' }
  }
  const existing = comp.tracks.find(
    (t) => t.kind === 'element' && t.frameId === input.frame_id && t.elementId === input.element_id,
  )
  if (existing) return { ok: true, trackId: existing.id, elementTrack: true }
  const loaded = (await store.load(canvas.id)) ?? canvas
  const frame = store.getFrame(input.frame_id)
  if (!frame || frame.pageId !== pageId) return { ok: false, error: `no frame ${input.frame_id} on page ${pageId}` }
  if (!loaded.frames.some((f) => f.id === frame.id)) {
    return { ok: false, error: `no frame ${input.frame_id} on page ${pageId}` }
  }
  if (!elementHtml(frame.html, input.element_id)) {
    return { ok: false, error: `no element ${input.element_id} in frame ${input.frame_id}` }
  }
  const trackId = `el-${newMotionId().slice(0, 10)}`
  return {
    ok: true,
    trackId,
    elementTrack: true,
    create: {
      op: 'add_track',
      track: {
        id: trackId,
        kind: 'element',
        frameId: frame.id,
        elementId: input.element_id,
        name: `Element ${input.element_id}`,
      },
    },
  }
}

export async function addEffect(
  canvas: Canvas,
  pageId: string,
  input: {
    track_id?: string
    frame_id?: string
    element_id?: string
    fx?: string
    id?: string
    params?: Record<string, unknown>
    index?: number
  },
  actor: Actor,
): Promise<Outcome> {
  const comp = compOf(canvas, pageId)
  if ('error' in comp) return comp
  const target = await elementTrack(canvas, pageId, comp, input)
  if (!target.ok) return fail(target.error)
  const track = comp.tracks.find((t) => t.id === target.trackId)
  if (track && !EFFECT_TRACK_KINDS.has(track.kind)) {
    return fail(
      `effects only draw on element, camera and adjustment tracks — ${track.kind} track ${track.id} would never render`,
    )
  }
  const spec = effectSpec(input.fx ?? '')
  if (!spec) return fail(`no effect ${input.fx} — list_motion_effects names the registry`)
  const bad = spec.validate(input.params ?? {})
  if (bad) return fail(bad)
  const effect: EffectInstance = {
    id: input.id ?? `fx-${newMotionId().slice(0, 10)}`,
    fx: spec.id,
    params: { ...spec.defaults(), ...(input.params ?? {}) } as EffectInstance['params'],
  }
  const ops: CompositionOp[] = [
    ...(target.create ? [target.create] : []),
    { op: 'add_effect', trackId: target.trackId, effect, index: input.index },
  ]
  return effectPatch(canvas, pageId, ops, actor)
}

export async function updateEffect(
  canvas: Canvas,
  pageId: string,
  input: {
    track_id?: string
    frame_id?: string
    element_id?: string
    effect_id?: string
    enabled?: boolean
    params?: Record<string, unknown>
    seed?: number
    mix?: number
    blend?: string | null
  },
  actor: Actor,
): Promise<Outcome> {
  const comp = compOf(canvas, pageId)
  if ('error' in comp) return comp
  const target = await elementTrack(canvas, pageId, comp, input)
  if (!target.ok) return fail(target.error)
  const track = comp.tracks.find((t) => t.id === target.trackId)
  if (!track) return fail(`no track ${input.track_id}`)
  const effect = track.effects?.find((e) => e.id === input.effect_id)
  if (!effect) return fail(`no effect ${input.effect_id} on track ${input.track_id}`)
  /* per-effect blend is parsed but never drawn — refuse storing one */
  if (input.blend != null) return fail('effect blend is not drawn yet — only clearing it is allowed')
  const spec = effectSpec(effect.fx)
  if (input.params && spec) {
    const bad = spec.validate({ ...effect.params, ...input.params })
    if (bad) return fail(bad)
  }
  const op: Extract<CompositionOp, { op: 'update_effect' }> = {
    op: 'update_effect',
    trackId: track.id,
    effectId: effect.id,
  }
  if (input.enabled !== undefined) op.enabled = input.enabled
  if (input.params !== undefined) op.params = input.params as EffectInstance['params']
  if (input.seed !== undefined) op.seed = input.seed
  if (input.mix !== undefined) op.mix = input.mix
  if (input.blend !== undefined) op.blend = input.blend as EffectInstance['blend'] | null
  return effectPatch(canvas, pageId, [op], actor)
}

export async function removeEffect(
  canvas: Canvas,
  pageId: string,
  input: { track_id?: string; frame_id?: string; element_id?: string; effect_id?: string },
  actor: Actor,
): Promise<Outcome> {
  const comp = compOf(canvas, pageId)
  if ('error' in comp) return comp
  const target = await elementTrack(canvas, pageId, comp, input)
  if (!target.ok) return fail(target.error)
  return effectPatch(
    canvas,
    pageId,
    [{ op: 'remove_effect', trackId: target.trackId, effectId: input.effect_id ?? '' }],
    actor,
  )
}

/** Replace a track's whole stack: reorder, rewrite params — one ops batch.
 *  `effects` lists complete instances; the stack becomes exactly that. */
export async function setEffects(
  canvas: Canvas,
  pageId: string,
  input: { track_id?: string; frame_id?: string; element_id?: string; effects?: EffectInstance[] },
  actor: Actor,
): Promise<Outcome> {
  const comp = compOf(canvas, pageId)
  if ('error' in comp) return comp
  const target = await elementTrack(canvas, pageId, comp, input)
  if (!target.ok) return fail(target.error)
  const track = comp.tracks.find((t) => t.id === target.trackId)
  if (track && !EFFECT_TRACK_KINDS.has(track.kind) && (input.effects ?? []).length > 0) {
    return fail(
      `effects only draw on element, camera and adjustment tracks — ${track.kind} track ${track.id} would never render`,
    )
  }
  const trackId = target.trackId
  const wanted = input.effects ?? []
  if (!Array.isArray(wanted) || wanted.length > 20) return fail('effects must be an array of at most 20')
  const seen = new Set<string>()
  for (const raw of wanted) {
    if (typeof raw?.id !== 'string' || typeof raw?.fx !== 'string') return fail('each effect needs id and fx')
    if (seen.has(raw.id)) return fail(`duplicate effect id ${raw.id}`)
    seen.add(raw.id)
    const spec = effectSpec(raw.fx)
    if (!spec) return fail(`no effect ${raw.fx} — list_motion_effects names the registry`)
    if (raw.blend != null) return fail('effect blend is not drawn yet — leave blend unset')
    const bad = spec.validate(raw.params ?? {})
    if (bad) return fail(bad)
  }
  const existing = track?.effects ?? []
  const ops: CompositionOp[] = target.create ? [target.create] : []
  for (const e of existing) {
    if (!seen.has(e.id)) ops.push({ op: 'remove_effect', trackId, effectId: e.id })
  }
  for (const [i, raw] of wanted.entries()) {
    const prev = existing.find((e) => e.id === raw.id)
    if (!prev) {
      ops.push({
        op: 'add_effect',
        trackId,
        index: i,
        effect: {
          id: raw.id,
          fx: raw.fx,
          params: { ...effectSpec(raw.fx)!.defaults(), ...(raw.params ?? {}) },
          ...(raw.enabled !== undefined ? { enabled: raw.enabled } : {}),
          ...(raw.seed !== undefined ? { seed: raw.seed } : {}),
          ...(raw.mix !== undefined ? { mix: raw.mix } : {}),
          ...(raw.blend !== undefined ? { blend: raw.blend } : {}),
        },
      })
    } else {
      ops.push({
        op: 'update_effect',
        trackId,
        effectId: raw.id,
        enabled: raw.enabled ?? prev.enabled,
        params: { ...effectSpec(raw.fx)!.defaults(), ...(raw.params ?? {}) },
        ...(raw.seed !== undefined ? { seed: raw.seed } : {}),
        ...(raw.mix !== undefined ? { mix: raw.mix } : {}),
        ...(raw.blend !== undefined ? { blend: raw.blend ?? null } : {}),
      })
    }
  }
  if (wanted.length > 0) {
    ops.push({ op: 'reorder_effects', trackId, effectIds: wanted.map((e) => e.id) })
  }
  return effectPatch(canvas, pageId, ops, actor)
}

/** A named look lands as an adjustment track carrying its stack; when
 *  `at`/`seconds` bound it, an adjustment clip gates the window. */
export function applyLook(
  canvas: Canvas,
  pageId: string,
  input: { look?: string; at?: number; seconds?: number },
  actor: Actor,
): Outcome {
  const comp = compOf(canvas, pageId)
  if ('error' in comp) return comp
  const look = MOTION_LOOKS.find((l) => l.id === input.look)
  if (!look) return fail(`no look ${input.look} — the registry names ${MOTION_LOOKS.map((l) => l.id).join(', ')}`)
  const trackId = `look-${look.id}`
  const effects = lookEffects(look.id)
  if (!effects) return fail(`look ${look.id} has no stack`)
  const windowClip =
    input.at !== undefined
      ? [
          {
            id: `lookwin-${newMotionId().slice(0, 8)}`,
            start: input.at,
            duration: input.seconds ?? comp.duration - input.at,
            source: { type: 'adjustment' as const },
          },
        ]
      : []
  const existing = comp.tracks.find((t) => t.id === trackId)
  const ops: CompositionOp[] = existing
    ? [
        { op: 'remove_track', trackId },
        {
          op: 'add_track',
          track: { id: trackId, kind: 'adjustment', name: `Look: ${look.label}`, effects, clips: windowClip },
        },
      ]
    : [
        {
          op: 'add_track',
          track: { id: trackId, kind: 'adjustment', name: `Look: ${look.label}`, effects, clips: windowClip },
        },
      ]
  const applied = actions.patchComposition(canvas.id, pageId, ops, actor)
  if (!applied.ok) return fail(applied.error ?? 'look rejected')
  return ok({ composition: applied.composition, look: look.id, track_id: trackId, effects: effects.length })
}

export function listLooks(): Outcome {
  return ok({ looks: MOTION_LOOKS.map((l) => ({ id: l.id, label: l.label, note: l.note })) })
}

/** the filmic shutter on the composition; `shutter: 0` clears to identity */
export function setMotionBlur(
  canvas: Canvas,
  pageId: string,
  input: { shutter?: number; samples?: number } | null,
  actor: Actor,
): Outcome {
  const comp = compOf(canvas, pageId)
  if ('error' in comp) return comp
  const motionBlur =
    input === null || input.shutter === undefined || input.shutter === 0
      ? null
      : { shutter: input.shutter, ...(input.samples !== undefined ? { samples: input.samples } : {}) }
  const applied = actions.patchComposition(canvas.id, pageId, [{ op: 'set_motion_blur', motionBlur }], actor)
  if (!applied.ok) return fail(applied.error ?? 'motion blur rejected')
  return ok({ composition: applied.composition, motionBlur: applied.composition.motionBlur ?? null })
}

/* ---- the element layer (motion-elements P0) ---- */

/**
 * The layer contract on an element track: `mode`/`visible`/`transform`/
 * `pad`/`scale`/`motion_blur` land as one `set_layer` (flat or nested under
 * `layer`), `blend` as `set_blend`, `matte` as `set_matte`, and `masks`
 * replaces the whole list atomically via `set_masks`. All fields optional
 * and merge — send `layer: null` to clear the spec.
 */
/* the layer fields the flat call carries — `set_layer` accepts them at
   the top level as documented, not only inside `layer` */
const FLAT_LAYER_FIELDS = ['mode', 'visible', 'transform', 'pad', 'scale', 'motion_blur'] as const

export async function setLayer(
  canvas: Canvas,
  pageId: string,
  input: {
    track_id?: string
    frame_id?: string
    element_id?: string
    layer?: Record<string, unknown> | null
    blend?: string | null
    matte?: Record<string, unknown> | null
    masks?: Record<string, unknown>[] | null
  } & Partial<Record<(typeof FLAT_LAYER_FIELDS)[number], unknown>>,
  actor: Actor,
): Promise<Outcome> {
  const comp = compOf(canvas, pageId)
  if ('error' in comp) return comp
  const target = await elementTrack(canvas, pageId, comp, input)
  if (!target.ok) return fail(target.error)
  if (!target.elementTrack) {
    return fail(`layers only exist on element tracks — ${input.track_id} is not one`)
  }
  /* normalize the flat controls into the partial layer spec — a field
     given both ways with a different value is a conflict, not a merge.
     The flat name is snake_case (the API spelling); the spec field is
     camelCase — motion_blur lands as motionBlur */
  const flat: Record<string, unknown> = {}
  const flatGiven: string[] = []
  for (const field of FLAT_LAYER_FIELDS) {
    if (input[field] !== undefined) {
      flat[field === 'motion_blur' ? 'motionBlur' : field] = input[field]
      flatGiven.push(field)
    }
  }
  let layer: Record<string, unknown> | null | undefined
  if (input.layer !== undefined) {
    if (input.layer === null) {
      if (flatGiven.length > 0) {
        return fail(`layer: null clears the spec — do not also pass ${flatGiven.join(', ')}`)
      }
      layer = null
    } else {
      for (const field of Object.keys(flat)) {
        if (input.layer[field] !== undefined && input.layer[field] !== flat[field]) {
          return fail(`${field} is given both flat and inside layer with different values`)
        }
      }
      layer = { ...input.layer, ...flat }
    }
  } else if (Object.keys(flat).length > 0) {
    layer = flat
  }

  const ops: CompositionOp[] = target.create ? [target.create] : []
  if (layer !== undefined) {
    ops.push({ op: 'set_layer', trackId: target.trackId, layer: layer as never })
  } else if (input.blend === undefined && input.matte === undefined && input.masks === undefined) {
    return fail('nothing to write — pass layer fields, blend, matte or masks')
  }
  if (input.blend !== undefined) {
    if (input.blend !== null && !BLEND_MODES.includes(input.blend as never)) {
      return fail(`blend must be one of ${BLEND_MODES.join(', ')} or null`)
    }
    ops.push({ op: 'set_blend', trackId: target.trackId, blend: input.blend as never })
  }
  if (input.matte !== undefined) {
    ops.push({ op: 'set_matte', trackId: target.trackId, matte: input.matte as never })
  }
  if (input.masks !== undefined) {
    /* the mask list replaces atomically in the caller's order — a diff
       could never express a reorder of ordered subtract/intersect masks */
    ops.push({ op: 'set_masks', trackId: target.trackId, masks: input.masks as never })
  }
  const applied = actions.patchComposition(canvas.id, pageId, ops, actor)
  if (!applied.ok) {
    const error = applied.error ?? 'layer rejected'
    /* fold a racing peer's freshly-created element track like effectPatch */
    if (/already exists|already has a track/.test(error) && target.create) {
      const retried = effectPatch(canvas, pageId, ops, actor)
      if (retried.ok) {
        const data = retried.data as { composition: Composition }
        return ok({ composition: data.composition, track_id: target.trackId })
      }
      return fail('layer rejected — a concurrent edit kept winning the race')
    }
    return fail(error)
  }
  return ok({ composition: applied.composition, track_id: target.trackId })
}

/**
 * The static layer plan: which element tracks promote per frame, in
 * composite order, with content/transform decisions, texture size (when
 * measurable server-side — it is not), cost and the MO-15..19 issues.
 * Measured geometry is the browser engine's job (P0-FE1 `__doopMotionPlan`);
 * the plan reports `geometry: 'unavailable'` and every rect-free field.
 */
export async function getLayerPlan(canvas: Canvas, pageId: string, input: { frame_id?: string }): Promise<Outcome> {
  const comp = compOf(canvas, pageId)
  if ('error' in comp) return comp
  const loaded = (await store.load(canvas.id)) ?? canvas
  const frames = loaded.frames.filter((f) => f.pageId === pageId).map((f) => ({ id: f.id, html: f.html }))
  const wanted = input.frame_id ? frames.filter((f) => f.id === input.frame_id) : frames
  if (input.frame_id && wanted.length === 0) return fail(`no frame ${input.frame_id} on page ${pageId}`)
  const plans: FramePlan[] = planLayers(comp, wanted, {
    html: new Map(frames.map((f) => [f.id, f.html])),
  })
  return ok({
    frames: plans,
    measured: false,
    note: 'static plan — measured geometry comes from the preview’s __doopMotionPlan; budgets needing a rect report unavailable rather than guessed',
  })
}

/* ---- element presets (motion-elements P0, plan d.1) ---- */

export function listElementPresets(): Outcome {
  return ok({ presets: elementPresetList() })
}

/* the patch seam tests inject a racing peer through — production always
   uses the real action */
export const presetDeps = { patchComposition: actions.patchComposition }

/**
 * Compile an element preset into ordinary keyframes on one or many element
 * tracks of one frame — the track is created when missing. `stagger`
 * offsets each element's start: `each`/`amount`, an ordering `from`, an
 * `ease` on the distribution and a `seed` for 'random'.
 */
export async function applyElementPreset(
  canvas: Canvas,
  pageId: string,
  input: {
    frame_id?: string
    element_ids?: string[]
    preset?: string
    at?: number
    duration?: number
    direction?: string | number
    distance?: number
    intensity?: number
    easing?: unknown
    seed?: number
    params?: Record<string, number>
    stagger?: { each?: number; amount?: number; from?: string; ease?: unknown; seed?: number }
  },
  actor: Actor,
): Promise<Outcome> {
  const comp = compOf(canvas, pageId)
  if ('error' in comp) return comp
  if (!isElementPreset(input.preset)) {
    return fail(`preset must be one of the list_element_presets ids`)
  }
  /* one element is element_ids: ['id'] — the public contract is plural
     only, on MCP and resident alike */
  const ids = input.element_ids ?? []
  if (ids.length === 0) return fail('element_ids is required')
  if (ids.length > 64) return fail('element_ids must name at most 64 elements')
  if (!input.frame_id) return fail('frame_id is required')
  const loaded = (await store.load(canvas.id)) ?? canvas
  const frame = store.getFrame(input.frame_id)
  if (!frame || frame.pageId !== pageId) return fail(`no frame ${input.frame_id} on page ${pageId}`)
  if (!loaded.frames.some((f) => f.id === frame.id)) return fail(`no frame ${input.frame_id} on page ${pageId}`)
  const missing = ids.filter((id) => !elementHtml(frame.html, id))
  if (missing.length > 0) return fail(`no elements ${missing.join(', ')} in frame ${frame.id}`)
  const at = input.at ?? 0
  if (!Number.isFinite(at) || at < 0 || at > comp.duration) {
    return fail(`at must be within the film [0, ${comp.duration}]`)
  }
  let easing: MotionEasing | undefined
  if (input.easing !== undefined) {
    const parsed = parseEasing(input.easing)
    if (!parsed) return fail('easing is not valid')
    easing = parsed
  }
  let direction: 'up' | 'down' | 'left' | 'right' | number | undefined
  if (typeof input.direction === 'number') direction = input.direction
  else if (input.direction !== undefined) {
    if (!['up', 'down', 'left', 'right'].includes(input.direction)) {
      return fail('direction must be up, down, left, right or degrees')
    }
    direction = input.direction as 'up' | 'down' | 'left' | 'right'
  }
  /* stagger positions: the element's inline left/top when it carries one —
     the static approximation until the measured plan lands */
  const positions = ids.map((id) => {
    const html = elementHtml(frame.html, id) ?? ''
    const left = /left\s*:\s*(-?[\d.]+)px/.exec(html)?.[1]
    const top = /top\s*:\s*(-?[\d.]+)px/.exec(html)?.[1]
    return { x: Number(left ?? 0), y: Number(top ?? 0) }
  })
  const stagger = input.stagger
  let offsets: number[]
  if (stagger) {
    const ease = stagger.ease !== undefined ? parseEasing(stagger.ease) : undefined
    if (stagger.ease !== undefined && !ease) return fail('stagger.ease is not valid')
    const STAGGER_FROM: readonly string[] = [
      'start',
      'end',
      'center',
      'edges',
      'random',
      'position-x',
      'position-y',
      'grid',
    ]
    const from = stagger.from ?? 'start'
    if (!STAGGER_FROM.includes(from)) return fail(`stagger.from must be one of ${STAGGER_FROM.join(', ')}`)
    const needsPositions = from === 'position-x' || from === 'position-y' || from === 'grid'
    offsets = staggerOffsets(
      ids.length,
      {
        each: stagger.each,
        amount: stagger.amount,
        from: from as StaggerOptions['from'],
        ease: ease ?? undefined,
        seed: stagger.seed ?? input.seed,
      },
      needsPositions ? positions : undefined,
    )
  } else {
    offsets = ids.map(() => 0)
  }
  if (ids.length !== new Set(ids).size) return fail('element_ids must not repeat')
  const spec = elementPresetSpec(input.preset)!
  const duration = input.duration ?? spec.duration
  if (!Number.isFinite(duration) || duration <= 0 || duration > ELEMENT_PRESET_MAX_DURATION) {
    return fail(`duration must be finite and ≤ ${ELEMENT_PRESET_MAX_DURATION}s`)
  }

  /* the whole batch is one atomic patch — every budget is checked against
     the composition AS READ, provisional tracks live in a request-local
     map (never in the live store), and a rejected patch leaves nothing
     behind. A peer's concurrent write can collide on a track id, so a
     conflict re-reads and retries instead of stranding half the batch. */
  for (let attempt = 1; attempt <= 3; attempt++) {
    const current = attempt === 1 ? comp : compOf(canvas, pageId)
    if ('error' in current) return current
    const last = at + duration + Math.max(0, ...offsets)
    if (last > current.duration + 1e-9) {
      return fail(`preset + stagger ends at ${last.toFixed(3)}s — past the film's ${current.duration}s`)
    }
    const existingByElement = new Map<string, MotionTrack>()
    for (const track of current.tracks) {
      if (track.kind === 'element' && track.frameId === frame.id && track.elementId) {
        existingByElement.set(track.elementId, track)
      }
    }
    const creating = ids.filter((id) => !existingByElement.has(id))
    if (current.tracks.length + creating.length > MOTION_LIMITS.MAX_TRACKS) {
      return fail(
        `the preset needs ${creating.length} new tracks on ${current.tracks.length} — over the ${MOTION_LIMITS.MAX_TRACKS} track budget`,
      )
    }

    /* bounded generation: preset loops are already clamped inside
       elementPreset; the per-track keyframe budget is checked against the
       written count before the ops reach the patch */
    const ops: CompositionOp[] = []
    const written: { element_id: string; track_id: string; offset: number; keyframes: number }[] = []
    let generationError: string | undefined
    for (const [i, elementId] of ids.entries()) {
      const existing = existingByElement.get(elementId)
      const trackId = existing?.id ?? `el-${newMotionId().slice(0, 10)}`
      if (!existing) {
        ops.push({
          op: 'add_track',
          track: { id: trackId, kind: 'element', frameId: frame.id, elementId, name: `Element ${elementId}` },
        })
      }
      let keyframes: MotionKeyframe[]
      try {
        keyframes = elementPreset(input.preset, {
          t: at + offsets[i]!,
          duration: input.duration,
          direction,
          distance: input.distance,
          intensity: input.intensity,
          easing,
          seed: (input.seed ?? 1) + i,
          params: input.params,
        })
      } catch (error) {
        generationError = error instanceof Error ? error.message : 'preset generation failed'
        break
      }
      const laneSize = existing?.keyframes?.length ?? 0
      if (laneSize + keyframes.length > MOTION_LIMITS.MAX_KEYFRAMES_PER_TRACK) {
        generationError = `${elementId}'s track holds ${laneSize} keyframes — the preset's ${keyframes.length} would pass the ${MOTION_LIMITS.MAX_KEYFRAMES_PER_TRACK} budget`
        break
      }
      for (const keyframe of keyframes) ops.push({ op: 'add_keyframe', trackId, keyframe })
      written.push({ element_id: elementId, track_id: trackId, offset: offsets[i]!, keyframes: keyframes.length })
    }
    if (generationError !== undefined) return fail(generationError)

    const applied = presetDeps.patchComposition(canvas.id, pageId, ops, actor)
    if (applied.ok) {
      return ok({
        composition: applied.composition,
        preset: input.preset,
        elements: written,
        note: 'every value landed as an ordinary editable keyframe',
      })
    }
    const error = applied.error ?? 'preset rejected'
    /* a peer can add the same element track between our read and the
       patch — that conflict retries against a fresh read; every other
       refusal is real */
    if (attempt < 3 && /already exists|already has a track/.test(error)) continue
    return fail(error)
  }
  return fail('preset rejected — a concurrent edit kept winning the race')
}

/* ---- one dispatch for every surface ---- */

/** The resident agent's flat name→call table; the MCP tools register the same
 * functions by hand because their schemas are richer. Kept here so every
 * surface answers through one code path. */
export async function execMotionPro(
  name: string,
  canvas: Canvas,
  raw: Record<string, unknown>,
  actor: Actor,
): Promise<Outcome> {
  const pageId = String(raw.page_id ?? '')
  switch (name) {
    case 'get_direction':
      return getDirection(canvas, pageId)
    case 'set_direction':
      return setDirection(canvas, pageId, raw.direction, actor)
    case 'list_motion_presets':
      return listMotionPresets()
    case 'apply_camera_preset':
      return applyCameraPreset(canvas, pageId, raw, actor)
    case 'apply_transition':
      return applyTransition(canvas, pageId, raw, actor)
    case 'apply_text_animation':
      return applyTextAnimation(canvas, pageId, raw, actor)
    case 'list_motion_effects':
      return listMotionEffects()
    case 'add_effect':
      return addEffect(canvas, pageId, raw, actor)
    case 'update_effect':
      return updateEffect(canvas, pageId, raw, actor)
    case 'remove_effect':
      return removeEffect(canvas, pageId, raw, actor)
    case 'set_effects':
      return setEffects(canvas, pageId, raw, actor)
    case 'apply_look':
      return applyLook(canvas, pageId, raw, actor)
    case 'list_looks':
      return listLooks()
    case 'set_motion_blur':
      return setMotionBlur(canvas, pageId, raw as { shutter?: number; samples?: number } | null, actor)
    case 'set_layer':
      return setLayer(canvas, pageId, raw, actor)
    case 'get_layer_plan':
      return getLayerPlan(canvas, pageId, raw)
    case 'list_element_presets':
      return listElementPresets()
    case 'apply_element_preset':
      return applyElementPreset(canvas, pageId, raw, actor)
    case 'get_scene_snapshot': {
      const { sceneSnapshot } = await import('./motionSnapshot.ts')
      return sceneSnapshot(canvas, pageId, raw as Parameters<typeof sceneSnapshot>[2])
    }
    case 'check_scene': {
      const { checkScene } = await import('./motionSnapshot.ts')
      return checkScene(canvas, pageId, raw as { pixels?: boolean })
    }
    case 'critique_scene': {
      const { critiqueScene } = await import('./motionSnapshot.ts')
      return critiqueScene(canvas, pageId, raw as { pixels?: boolean })
    }
    default:
      return fail(`unknown motion tool ${name}`)
  }
}
