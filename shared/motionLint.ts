/**
 * shared/motionLint.ts — the seek-safety lint, `lint_motion`.
 *
 * A film is a page with a clock: at render time every pixel must be a pure
 * function of the seek time. These rules flag the things that break that —
 * wall clocks, free-running loops, unseeded randomness, CSS animations that
 * are not bound to the timeline, GSAP, autoplaying media, malformed motion
 * blocks. It is a static pass over the frame HTML, plus composition-level
 * consistency checks; the same code backs the MCP tool and the editor badge.
 */

import {
  BLEND_MODES,
  DURATION_ATTR,
  MOTION_BLOCK_ATTR,
  SCENE_ATTR,
  SEEK_EVENT,
  START_ATTR,
  TEXT_SPLITS,
  TEXT_SPLIT_ATTR,
  parseMotionBlock,
  type BlendMode,
  type Composition,
  type MotionLintIssue,
  type MotionTrack,
} from './motion.ts'
import { EFFECT_STACK_MAX, GL_EFFECT_IDS, effectSpec, resolvedEnabled } from './motionFx.ts'

/** the MO-* rule ids, in firing order */
export const MO_RULES = {
  WALL_CLOCK: 'MO-01',
  FREE_RUNNING: 'MO-02',
  UNSEEDED_RANDOM: 'MO-03',
  CSS_ANIMATION: 'MO-04',
  GSAP: 'MO-05',
  SEEK_NETWORK: 'MO-06',
  MEDIA_AUTOPLAY: 'MO-07',
  TIMED_MEDIA_NESTED: 'MO-08',
  SCENE_INCOMPLETE: 'MO-09',
  MOTION_BLOCK: 'MO-10',
  COMPOSITION: 'MO-11',
  TEXT_SPLIT: 'MO-12',
  FX_DANGLING: 'MO-13',
  FX_UNSUPPORTED: 'MO-14',
} as const

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
const STYLE_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi
const INLINE_STYLE_RE = /\bstyle\s*=\s*"([^"]*)"/gi
const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*?)\/?>/g

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const WALL_CLOCK_RE = /\b(?:Date\.now|new\s+Date|Date\.parse|performance\.now)\s*\(/
const LOOP_RE = /\b(?:setInterval|setTimeout|requestAnimationFrame)\s*\(/
const RANDOM_RE = /\bMath\.random\s*\(/
const SEEDED_RE = /\b(?:seed|seeded|seedrandom|mulberry|xorshift|sfc32|prng|alea)\b/i
const NETWORK_RE = /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b/
const GSAP_RE = /\b(?:gsap|TweenMax|TimelineMax|TweenLite|TimelineLite)\b/
const GSAP_SRC_RE = /gsap|TweenMax/i
const ANIMATION_DECL_RE = /(?:^|[;{])\s*animation(?:-[a-z-]+)?\s*:[^;}]+/gi

/** The subtree of the element carrying `data-doop-id` — a tag-balance walk
 *  from its opening tag (HTML in this codebase is template-authored, never
 *  arbitrary). Void elements return the tag alone; no match returns null. */
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
])
export function elementHtml(html: string, elementId: string): string | null {
  const open = new RegExp(`<([a-zA-Z][a-zA-Z0-9]*)[^>]*data-doop-id\\s*=\\s*["']${esc(elementId)}["'][^>]*>`).exec(html)
  if (!open) return null
  const tag = open[1]!.toLowerCase()
  if (open[0].endsWith('/>') || VOID_TAGS.has(tag)) return open[0]
  const tagRe = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi')
  tagRe.lastIndex = open.index + open[0].length
  let depth = 1
  for (let m = tagRe.exec(html); m; m = tagRe.exec(html)) {
    depth += m[0].startsWith('</') ? -1 : m[0].endsWith('/>') ? 0 : 1
    if (depth === 0) return html.slice(open.index, m.index + m[0].length)
  }
  return html.slice(open.index)
}

function snippet(text: string, index: number, span = 60): string {
  const start = Math.max(0, index - 10)
  return text
    .slice(start, index + span)
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Static seek-safety pass over one frame's HTML. `frameId` tags the issues
 * for reporting. Only flags what makes pixels depend on something other
 * than t — transitions and load-time work are fine.
 */
export function lintMotionHtml(html: string, frameId?: string): MotionLintIssue[] {
  const issues: MotionLintIssue[] = []
  const push = (rule: string, severity: MotionLintIssue['severity'], message: string, snip?: string) =>
    issues.push({ rule, severity, message, ...(frameId ? { frameId } : {}), ...(snip ? { snippet: snip } : {}) })

  /* scripts */
  for (const m of html.matchAll(SCRIPT_RE)) {
    const attrs = m[1] ?? ''
    const body = m[2] ?? ''
    const at = m.index ?? 0
    if (/\bsrc\s*=/.test(attrs) && GSAP_SRC_RE.test(attrs)) {
      push(
        MO_RULES.GSAP,
        'error',
        'GSAP is not seek-safe and not licensed for our runtime — rewrite with timeline keyframes or WAAPI bound to --t',
        snippet(html, at),
      )
    }
    if (attrs.includes(MOTION_BLOCK_ATTR)) {
      const block = parseMotionBlock(body)
      if (!block) {
        push(
          MO_RULES.MOTION_BLOCK,
          'error',
          `${MOTION_BLOCK_ATTR} block does not parse as { v: 1, keyframes: [...] }`,
          snippet(body, 0, 80),
        )
      } else {
        /* a text animator's element must carry data-doop-split — the player
           derives the units it animates */
        for (const animator of block.animators ?? []) {
          const elRe = new RegExp(`data-doop-id\\s*=\\s*["']${esc(animator.el)}["'][^>]*`)
          const tag = html.match(elRe)?.[0] ?? ''
          if (tag && !tag.includes(TEXT_SPLIT_ATTR)) {
            push(
              MO_RULES.TEXT_SPLIT,
              'warning',
              `animator on "${animator.el}" has no ${TEXT_SPLIT_ATTR} on the element — the player cannot derive its ${animator.split} units`,
              tag.slice(0, 100),
            )
          }
        }
      }
      continue
    }
    if (!body.trim()) continue
    if (WALL_CLOCK_RE.test(body)) {
      push(
        MO_RULES.WALL_CLOCK,
        'error',
        'a wall clock (Date.now / new Date / performance.now) makes pixels depend on render time, not t — drive it from --t or the seek event',
        snippet(body, WALL_CLOCK_RE.exec(body)!.index),
      )
    }
    if (LOOP_RE.test(body) && !body.includes(SEEK_EVENT)) {
      push(
        MO_RULES.FREE_RUNNING,
        'error',
        'a free-running timer or rAF loop is not seekable — restructure it as a function of t and listen for doop:seek',
        snippet(body, LOOP_RE.exec(body)!.index),
      )
    }
    if (RANDOM_RE.test(body) && !SEEDED_RE.test(body)) {
      push(
        MO_RULES.UNSEEDED_RANDOM,
        'error',
        'unseeded Math.random differs on every render — seed a local PRNG so every seek lands the same',
        snippet(body, RANDOM_RE.exec(body)!.index),
      )
    }
    if (NETWORK_RE.test(body)) {
      push(
        MO_RULES.SEEK_NETWORK,
        'warning',
        'network access inside a scene script may fire at seek time — load once at page setup and cache it',
        snippet(body, NETWORK_RE.exec(body)!.index),
      )
    }
    if (GSAP_RE.test(body)) {
      push(
        MO_RULES.GSAP,
        'error',
        'GSAP is not seek-safe and not licensed for our runtime — rewrite with timeline keyframes or WAAPI bound to --t',
        snippet(body, GSAP_RE.exec(body)!.index),
      )
    }
  }

  /* styles: animations must be bound to the timeline — paused and delayed
     by var(--t) — anything else runs on the wall clock */
  const styleText = [
    ...[...html.matchAll(STYLE_RE)].map((m) => m[1] ?? ''),
    ...[...html.matchAll(INLINE_STYLE_RE)].map((m) => m[1] ?? ''),
  ].join('\n')
  if (styleText) {
    const bound = /animation-play-state\s*:\s*paused/.test(styleText) && styleText.includes('var(--t')
    for (const m of styleText.matchAll(ANIMATION_DECL_RE)) {
      const decl = m[0]
      if (/animation-name\s*:\s*(none|initial|inherit)\b/.test(decl)) continue
      if (/\binfinite\b/.test(decl)) {
        push(
          MO_RULES.CSS_ANIMATION,
          'error',
          'an infinite CSS animation has no place on a finite timeline — give the scene a finite duration and keyframe the loop',
          decl.trim().slice(0, 100),
        )
      } else if (!bound) {
        push(
          MO_RULES.CSS_ANIMATION,
          'error',
          'a CSS animation that is not bound to the timeline runs on wall-clock load time — pause it and drive animation-delay from var(--t), or use keyframes',
          decl.trim().slice(0, 100),
        )
      }
    }
  }

  /* media + timing structure */
  if (/<(?:video|audio)\b[^>]*\bautoplay\b/i.test(html)) {
    push(
      MO_RULES.MEDIA_AUTOPLAY,
      'error',
      'autoplay media runs on wall-clock load — the runtime seeks media at t; drop autoplay',
      '<video/audio autoplay>',
    )
  }
  {
    /* walk the tag stream: a timed media element nested inside another
       timed element is an error (HyperFrames' clamp rule) */
    const stack: { tag: string; timed: boolean }[] = []
    for (const m of html.matchAll(TAG_RE)) {
      const raw = m[0]
      const tag = (m[1] ?? '').toLowerCase()
      const attrs = m[2] ?? ''
      const closing = raw.startsWith('</')
      const selfClosing = raw.endsWith('/>') || ['img', 'br', 'input', 'source', 'track', 'meta', 'link'].includes(tag)
      if (closing) {
        while (stack.length && stack[stack.length - 1]!.tag !== tag) stack.pop()
        stack.pop()
        continue
      }
      const timed = new RegExp(`${esc(START_ATTR)}\\s*=`).test(attrs)
      const timedAncestor = stack.some((s) => s.timed)
      if ((tag === 'video' || tag === 'audio') && timed && timedAncestor) {
        push(
          MO_RULES.TIMED_MEDIA_NESTED,
          'error',
          'timed media nested inside another timed element: keep data-start on the media or the wrapper, not both',
          raw.slice(0, 100),
        )
      }
      if (!selfClosing) stack.push({ tag, timed })
    }
  }

  /* scene root sanity */
  if (html.includes(SCENE_ATTR)) {
    const root = html.match(new RegExp(`<[^>]+${esc(SCENE_ATTR)}[^>]*>`))?.[0] ?? ''
    if (root && !new RegExp(`${esc(DURATION_ATTR)}\\s*=`).test(root)) {
      push(
        MO_RULES.SCENE_INCOMPLETE,
        'warning',
        `${SCENE_ATTR} root has no ${DURATION_ATTR} — the runtime cannot give the scene a length`,
        root.slice(0, 100),
      )
    }
  }

  /* split markers: the value must name a real split */
  for (const m of html.matchAll(new RegExp(`${esc(TEXT_SPLIT_ATTR)}\\s*=\\s*["']([^"']*)["']`, 'g'))) {
    if (!TEXT_SPLITS.includes(m[1] as (typeof TEXT_SPLITS)[number])) {
      push(
        MO_RULES.TEXT_SPLIT,
        'warning',
        `${TEXT_SPLIT_ATTR}="${m[1]}" is not one of ${TEXT_SPLITS.join(', ')} — the element will not split into units`,
        snippet(html, m.index ?? 0),
      )
    }
  }

  return issues
}

/**
 * Composition-level checks: consistency inside the timeline and against the
 * page's frames (`frameIds`, when given — element tracks and frame clips
 * that point outside the page are flagged, not hard errors, since a page's
 * frames may arrive deferred).
 */
export function lintComposition(comp: Composition, opts?: { frameIds?: ReadonlySet<string> }): MotionLintIssue[] {
  const issues: MotionLintIssue[] = []
  const push = (severity: MotionLintIssue['severity'], message: string) =>
    issues.push({ rule: MO_RULES.COMPOSITION, severity, message })

  if (comp.tracks.length === 0) push('warning', 'the composition has no tracks — nothing plays')
  if (comp.tracks.filter((t) => t.kind === 'camera').length > 1) push('error', 'more than one camera track')

  for (const track of comp.tracks) {
    if (track.kind === 'element' && (!track.frameId || !track.elementId)) {
      push('error', `element track ${track.id} has no frameId/elementId target`)
    }
    if (track.kind === 'element' && track.frameId && opts?.frameIds && !opts.frameIds.has(track.frameId)) {
      push('warning', `element track ${track.id} targets a frame not on the page`)
    }
    for (const kf of track.keyframes ?? []) {
      if (kf.t > comp.duration) push('error', `keyframe ${kf.id} sits past the composition duration`)
      if (track.kind === 'camera' && !['x', 'y', 'zoom', 'rotation'].includes(kf.property)) {
        push('error', `camera keyframe ${kf.id} uses a non-camera property "${kf.property}"`)
      }
    }
    for (const clip of track.clips ?? []) {
      if (clip.start + clip.duration > comp.duration + 1e-9) {
        push('warning', `clip ${clip.id} ends past the composition duration`)
      }
      const src = clip.source
      if (src.type === 'frame' && opts?.frameIds && !opts.frameIds.has(src.frameId)) {
        push('warning', `clip ${clip.id} references a frame not on the page`)
      }
      const allowed =
        track.kind === 'clip'
          ? clip.source.type === 'frame' || clip.source.type === 'library' || clip.source.type === 'asset'
          : track.kind === 'audio'
            ? clip.source.type === 'asset'
            : track.kind === 'caption'
              ? clip.source.type === 'caption'
              : track.kind === 'adjustment'
                ? clip.source.type === 'adjustment'
                : false
      if (!allowed) push('error', `a ${clip.source.type} clip does not belong on a ${track.kind} track`)
      if (clip.transition && clip.transition.duration > clip.duration) {
        push(
          'warning',
          `clip ${clip.id}'s transition (${clip.transition.duration}s) outlives the clip (${clip.duration}s)`,
        )
      }
      if (clip.transition && track.kind !== 'clip') {
        push(
          'warning',
          `clip ${clip.id} has a transition but sits on a ${track.kind} track — transitions pair shots on clip tracks`,
        )
      }
    }
    if ((track.kind === 'camera' || track.kind === 'element') && (track.clips ?? []).length > 0) {
      push('error', `${track.kind} track ${track.id} carries clips`)
    }

    /* MO-13: an fx:<id>.<param> lane pointing at no instance on the stack
       dangles — the value it would set is silently lost at eval time */
    const stackIds = new Set((track.effects ?? []).map((e) => e.id))
    for (const kf of track.keyframes ?? []) {
      if (!kf.property.startsWith('fx:')) continue
      const instance = kf.property.slice(3).split('.')[0]
      if (instance && !stackIds.has(instance)) {
        issues.push({
          rule: 'MO-13',
          kind: 'dangling_lane',
          severity: 'warning',
          message: `keyframe ${kf.id} targets fx:${instance} but no effect ${instance} is on track ${track.id}`,
        })
      }
    }
    /* MO-14: an enabled effect the shipped renderer cannot draw — the stack
       is valid, the pixels just will not show it */
    for (const e of track.effects ?? []) {
      if (e.enabled === false) continue
      if (!GL_EFFECT_IDS.has(e.fx)) {
        issues.push({
          rule: 'MO-14',
          kind: 'undrawn_effect',
          severity: 'warning',
          message: `effect ${e.fx} (${e.id}) on ${track.id} has no WebGL2 body — the compositor reports it instead of drawing it wrong`,
        })
      }
    }
  }
  return issues
}

/* ---- check_scene's candidate stack (motion-pro AC-11) ----
 * A caller can price and vet the stack set_effects would write before it
 * writes it. The candidate never persists: shape problems come back as an
 * input error, registry problems as diagnostics under the same MO-13/MO-14
 * families the stored composition uses, with a `kind` that keeps them
 * distinct from the stored meanings (dangling_lane / undrawn_effect). */

/** one candidate diagnostic — an issue plus where in the stack it sits */
export interface CandidateStackDiagnostic extends MotionLintIssue {
  /** unknown_fx | fx_mismatch | invalid_param | undrawn_effect — all but
   *  undrawn refuse the write as errors; an undrawn candidate warns like
   *  the stored rule */
  kind: 'unknown_fx' | 'fx_mismatch' | 'invalid_param' | 'undrawn_effect'
  track_id: string
  /** the effect instance id, when the shape gave one */
  instance?: string
  /** the offending param or field, when one is named */
  parameter?: string
}

const FX_ID_RE = /^[a-z][a-z0-9-]{0,59}$/

/** the shape gate a write applies at parse — registry and param values are
 *  the diagnostics' job below; a null return means the candidate is
 *  shape-clean enough to evaluate */
function candidateShapeError(effects: unknown): string | null {
  if (!Array.isArray(effects)) return 'candidate_stack.effects must be an array'
  if (effects.length > EFFECT_STACK_MAX) return `candidate_stack.effects must be at most ${EFFECT_STACK_MAX}`
  const seen = new Set<string>()
  for (const [i, raw] of effects.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return `candidate effect ${i} must be an object`
    const e = raw as Record<string, unknown>
    if (typeof e.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(e.id))
      return `candidate effect ${i}.id must be a 1-100 char id`
    if (seen.has(e.id)) return `duplicate candidate effect id ${e.id}`
    seen.add(e.id)
    if (typeof e.fx !== 'string' || !FX_ID_RE.test(e.fx))
      return `candidate effect ${e.id}.fx must be a registry id (lowercase, dashes)`
    if (e.enabled !== undefined && typeof e.enabled !== 'boolean')
      return `candidate effect ${e.id}.enabled must be a boolean`
    if (e.seed !== undefined && (typeof e.seed !== 'number' || !Number.isInteger(e.seed) || e.seed < 0)) {
      return `candidate effect ${e.id}.seed must be a non-negative integer`
    }
    if (e.mix !== undefined && (typeof e.mix !== 'number' || !Number.isFinite(e.mix) || e.mix < 0 || e.mix > 1)) {
      return `candidate effect ${e.id}.mix must be in [0, 1]`
    }
    if (e.blend !== undefined && !BLEND_MODES.includes(e.blend as BlendMode)) {
      return `candidate effect ${e.id}.blend must be one of ${BLEND_MODES.join(', ')}`
    }
    if (e.params !== undefined) {
      if (typeof e.params !== 'object' || e.params === null || Array.isArray(e.params)) {
        return `candidate effect ${e.id}.params must be an object`
      }
      for (const v of Object.values(e.params)) {
        if (typeof v !== 'number' && typeof v !== 'string' && typeof v !== 'boolean') {
          return `candidate effect ${e.id}.params values must be numbers, strings or booleans`
        }
      }
    }
  }
  return null
}

/**
 * Vet a candidate stack for `track` without writing it. Returns the input
 * error when the shape fails the same bounds a write enforces, else the
 * structured diagnostics: `unknown_fx` under MO-13 for an id the registry
 * does not carry, `invalid_param` under MO-14 for a value the registry
 * validator rejects (bounds, booleans, enums) or a blend the write refuses,
 * and `undrawn_effect` under MO-14 for an enabled registry effect this GL
 * build cannot draw.
 */
export function lintCandidateStack(
  track: MotionTrack,
  effects: unknown,
): { error: string } | { diagnostics: CandidateStackDiagnostic[] } {
  const shapeError = candidateShapeError(effects)
  if (shapeError) return { error: shapeError }
  const diagnostics: CandidateStackDiagnostic[] = []
  for (const raw of effects as Record<string, unknown>[]) {
    const e = raw as { id: string; fx: string; enabled?: boolean; blend?: string; params?: Record<string, unknown> }
    const base = { track_id: track.id, instance: e.id }
    const spec = effectSpec(e.fx)
    if (!spec) {
      diagnostics.push({
        ...base,
        rule: 'MO-13',
        kind: 'unknown_fx',
        severity: 'error',
        message: `effect ${e.fx} is not in the registry — list_motion_effects names what the stack may carry`,
      })
      continue
    }
    /* same contract the write applies: an id reused with a different fx is
       refused — set_effects merges onto the stored instance, whose fx is
       immutable identity */
    const prev = (track.effects ?? []).find((s) => s.id === e.id)
    if (prev && prev.fx !== e.fx) {
      diagnostics.push({
        ...base,
        rule: 'MO-13',
        kind: 'fx_mismatch',
        severity: 'error',
        message: `effect ${e.id} is ${prev.fx} — an id keeps its fx through set_effects; remove it and add a new instance to change the type`,
      })
    }
    for (const key of Object.keys(e.params ?? {})) {
      /* one param per call, so the diagnostic can name the field — the
         message is the registry validator's own */
      const bad = spec.validate({ [key]: e.params![key] })
      if (bad) {
        diagnostics.push({
          ...base,
          rule: 'MO-14',
          kind: 'invalid_param',
          severity: 'error',
          parameter: key,
          message: bad,
        })
      }
    }
    if (e.blend !== undefined) {
      diagnostics.push({
        ...base,
        rule: 'MO-14',
        kind: 'invalid_param',
        severity: 'error',
        parameter: 'blend',
        message: 'effect blend is not drawn yet — the write refuses it, leave blend unset',
      })
    }
    /* the write's merge decides what draws: a reused id that omits
       `enabled` keeps its stored flag, so a disabled instance resubmitted
       bare stays dark and must not warn */
    if (resolvedEnabled(e, prev) && !GL_EFFECT_IDS.has(e.fx)) {
      diagnostics.push({
        ...base,
        rule: 'MO-14',
        kind: 'undrawn_effect',
        severity: 'warning',
        message: `effect ${e.fx} (${e.id}) has no WebGL2 body in this build — the compositor reports it instead of drawing it wrong`,
      })
    }
  }
  return { diagnostics }
}

/** one number agents can quote: errors first */
export function motionLintSummary(issues: readonly MotionLintIssue[]): {
  errors: number
  warnings: number
  text: string
} {
  const errors = issues.filter((i) => i.severity === 'error').length
  const warnings = issues.length - errors
  const text =
    issues.length === 0
      ? 'lint clean — the page is seek-safe'
      : `${errors} error(s), ${warnings} warning(s) — the page is not fully seek-safe`
  return { errors, warnings, text }
}
