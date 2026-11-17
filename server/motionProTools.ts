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
  newMotionId,
  parseEasing,
  parseMotionBlock,
  TEXT_ANIMATOR_PRESETS,
  TEXT_SPLITS,
  TRANSITION_DIRECTIONS,
  TRANSITION_KINDS,
  type CompositionOp,
  type Direction,
  type EffectInstance,
  type FrameTextAnimator,
  type MotionEasing,
  type MotionTransition,
  type TextOrder,
  type TextSplit,
} from '../shared/motion.ts'
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
      params: fx.params,
      ...(fx.gen ? { generates: true } : {}),
      /* luma matte and displacement map bind the layer's own picture on
         u_tex2 until instances can point at another element's texture —
         say so, or an agent expects a matte from another layer */
      ...(fx.needsInput ? { needs_input: true } : {}),
      ...(fx.selfMapped ? { self_mapped: true } : {}),
    })),
    blend_modes: BLEND_MODES,
  })
}

/** effect ops share their plumbing: validate ids, patch, report */
function effectPatch(canvas: Canvas, pageId: string, ops: CompositionOp[], actor: Actor): Outcome {
  const comp = compOf(canvas, pageId)
  if ('error' in comp) return comp
  const applied = actions.patchComposition(canvas.id, pageId, ops, actor)
  if (!applied.ok) return fail(applied.error ?? 'rejected')
  return ok({ composition: applied.composition })
}

export function addEffect(
  canvas: Canvas,
  pageId: string,
  input: { track_id?: string; fx?: string; id?: string; params?: Record<string, unknown>; index?: number },
  actor: Actor,
): Outcome {
  const comp = compOf(canvas, pageId)
  if ('error' in comp) return comp
  const track = comp.tracks.find((t) => t.id === input.track_id)
  if (!track) return fail(`no track ${input.track_id}`)
  /* the raster/GL pass only reads camera and adjustment stacks — an effect
     anywhere else would sit undrawn, so the write is refused */
  if (track.kind !== 'camera' && track.kind !== 'adjustment') {
    return fail(
      `effects only draw on camera and adjustment tracks — ${track.kind} track ${track.id} would never render`,
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
  return effectPatch(canvas, pageId, [{ op: 'add_effect', trackId: track.id, effect, index: input.index }], actor)
}

export function updateEffect(
  canvas: Canvas,
  pageId: string,
  input: {
    track_id?: string
    effect_id?: string
    enabled?: boolean
    params?: Record<string, unknown>
    seed?: number
    mix?: number
    blend?: string | null
  },
  actor: Actor,
): Outcome {
  const comp = compOf(canvas, pageId)
  if ('error' in comp) return comp
  const track = comp.tracks.find((t) => t.id === input.track_id)
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

export function removeEffect(
  canvas: Canvas,
  pageId: string,
  input: { track_id?: string; effect_id?: string },
  actor: Actor,
): Outcome {
  const comp = compOf(canvas, pageId)
  if ('error' in comp) return comp
  const track = comp.tracks.find((t) => t.id === input.track_id)
  if (!track) return fail(`no track ${input.track_id}`)
  return effectPatch(
    canvas,
    pageId,
    [{ op: 'remove_effect', trackId: track.id, effectId: input.effect_id ?? '' }],
    actor,
  )
}

/** Replace a track's whole stack: reorder, rewrite params — one ops batch.
 *  `effects` lists complete instances; the stack becomes exactly that. */
export function setEffects(
  canvas: Canvas,
  pageId: string,
  input: { track_id?: string; effects?: EffectInstance[] },
  actor: Actor,
): Outcome {
  const comp = compOf(canvas, pageId)
  if ('error' in comp) return comp
  const track = comp.tracks.find((t) => t.id === input.track_id)
  if (!track) return fail(`no track ${input.track_id}`)
  if (track.kind !== 'camera' && track.kind !== 'adjustment' && (input.effects ?? []).length > 0) {
    return fail(
      `effects only draw on camera and adjustment tracks — ${track.kind} track ${track.id} would never render`,
    )
  }
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
  const existing = track.effects ?? []
  const ops: CompositionOp[] = []
  for (const e of existing) {
    if (!seen.has(e.id)) ops.push({ op: 'remove_effect', trackId: track.id, effectId: e.id })
  }
  for (const [i, raw] of wanted.entries()) {
    const prev = existing.find((e) => e.id === raw.id)
    if (!prev) {
      ops.push({
        op: 'add_effect',
        trackId: track.id,
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
        trackId: track.id,
        effectId: raw.id,
        enabled: raw.enabled ?? prev.enabled,
        params: { ...effectSpec(raw.fx)!.defaults(), ...(raw.params ?? {}) },
        ...(raw.seed !== undefined ? { seed: raw.seed } : {}),
        ...(raw.mix !== undefined ? { mix: raw.mix } : {}),
        ...(raw.blend !== undefined ? { blend: raw.blend ?? null } : {}),
      })
    }
  }
  ops.push({ op: 'reorder_effects', trackId: track.id, effectIds: wanted.map((e) => e.id) })
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
