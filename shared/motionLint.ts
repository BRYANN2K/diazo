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
  DURATION_ATTR,
  MOTION_BLOCK_ATTR,
  SCENE_ATTR,
  SEEK_EVENT,
  START_ATTR,
  TEXT_SPLITS,
  TEXT_SPLIT_ATTR,
  parseMotionBlock,
  type Composition,
  type MotionLintIssue,
} from './motion.ts'

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
  }
  return issues
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
