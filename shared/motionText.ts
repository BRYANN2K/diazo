/**
 * shared/motionText.ts — the text animator (proposal 14.5). An element's
 * text stays one editable string; `data-doop-split` names the unit split
 * and a FrameTextAnimator spec in the frame's `data-doop-motion` block says
 * how the units arrive. The player derives units at runtime and this module
 * folds a spec into ordinary FrameMotionKeyframes on generated unit
 * targets, so compilers and renderers need no DOM.
 *
 * Unit addressing: unit i of element `el` is `unitSelector(el, i)` =
 * `"el[i]"` — the i-th span the player's split produced. The split rules
 * here are the contract: the player must produce the same count.
 */

import { seededRandom } from './motionPresets.ts'
import type { FrameMotionKeyframe, FrameTextAnimator, MotionEasing, TextOrder, TextSplit } from './motion.ts'

export const unitSelector = (el: string, i: number): string => `${el}[${i}]`

/**
 * The unit split the player reproduces in the DOM:
 * - line: `textContent` split on newlines (empty lines are units too —
 *   a `<br>`-separated DOM produces the same indices);
 * - word: runs of non-whitespace;
 * - char: non-whitespace code points.
 */
export function splitTextUnits(text: string, split: TextSplit): string[] {
  if (split === 'line') return text.split('\n')
  if (split === 'word') return text.match(/\S+/g) ?? []
  return Array.from(text.replace(/\s+/g, ''))
}

/**
 * `seq[i]` = the position unit i plays at: forward is identity, center
 * radiates from the middle out (ties to the left), random is a seeded
 * Fisher–Yates shuffle.
 */
export function unitOrder(n: number, order: TextOrder, seed = 1): number[] {
  if (n <= 0) return []
  if (order === 'forward') return Array.from({ length: n }, (_, i) => i)
  if (order === 'center') {
    const mid = (n - 1) / 2
    const byRank = Array.from({ length: n }, (_, i) => i).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b)
    const seq = new Array<number>(n)
    byRank.forEach((unit, pos) => (seq[unit] = pos))
    return seq
  }
  const idx = Array.from({ length: n }, (_, i) => i)
  const rng = seededRandom(seed)
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[idx[i], idx[j]] = [idx[j]!, idx[i]!]
  }
  const seq = new Array<number>(n)
  idx.forEach((unit, pos) => (seq[unit] = pos))
  return seq
}

const EASE_OUT: MotionEasing = { type: 'cubic-bezier', x1: 0, y1: 0, x2: 0.58, y2: 1 }
const WIPE: MotionEasing = { type: 'cubic-bezier', x1: 0.2, y1: 0.8, x2: 0.2, y2: 1 }
const POP: MotionEasing = { type: 'spring', stiffness: 300, damping: 24, mass: 1 }
const STEP_ONE: MotionEasing = { type: 'steps', steps: 1, position: 'end' }
const STEP_TWO: MotionEasing = { type: 'steps', steps: 2, position: 'end' }

/** per-unit segments a preset writes, as (prop, from, to) triples */
function presetSegments(animator: FrameTextAnimator): { prop: string; from: number | string; to: number | string }[] {
  switch (animator.preset) {
    case 'rise-blur':
      return [
        { prop: 'opacity', from: 0, to: 1 },
        { prop: 'y', from: 24, to: 0 },
        { prop: 'blur', from: 8, to: 0 },
      ]
    case 'typewriter':
      return [{ prop: 'opacity', from: 0, to: 1 }]
    case 'scale-pop':
      return [
        { prop: 'opacity', from: 0, to: 1 },
        { prop: 'scale', from: 0.4, to: 1 },
      ]
    case 'mask-wipe':
      return [
        { prop: 'opacity', from: 0, to: 1 },
        { prop: 'clipPath', from: 'inset(0% 100% 0% 0%)', to: 'inset(0% 0% 0% 0%)' },
      ]
    case 'tracking-in':
      return [{ prop: 'opacity', from: 0, to: 1 }]
    case 'scramble':
      return [{ prop: 'opacity', from: 0, to: 1 }]
  }
}

function presetEase(animator: FrameTextAnimator): MotionEasing {
  if (animator.ease) return animator.ease
  switch (animator.preset) {
    case 'typewriter':
      return STEP_ONE
    case 'scale-pop':
      return POP
    case 'mask-wipe':
      return WIPE
    case 'scramble':
      return STEP_TWO
    default:
      return EASE_OUT
  }
}

/**
 * Fold an animator spec into unit keyframes: each unit i gets its segments
 * starting at `start + seq[i] * stagger`. For `tracking-in` the units also
 * converge: unit i slides from `(i - center) * 18` px to 0.
 */
export function expandTextAnimator(
  animator: FrameTextAnimator,
  text: string,
): { units: string[]; keyframes: FrameMotionKeyframe[] } {
  const units = splitTextUnits(text, animator.split)
  const seq = unitOrder(units.length, animator.order ?? 'forward', animator.seed ?? 1)
  const ease = presetEase(animator)
  const segments = presetSegments(animator)
  const keyframes: FrameMotionKeyframe[] = []
  const mid = (units.length - 1) / 2
  for (let i = 0; i < units.length; i++) {
    const t0 = animator.start + seq[i]! * animator.stagger
    const el = unitSelector(animator.el, i)
    for (const seg of segments) {
      keyframes.push({ el, prop: seg.prop, t: t0, value: seg.from, ease })
      keyframes.push({ el, prop: seg.prop, t: t0 + animator.duration, value: seg.to })
    }
    if (animator.preset === 'tracking-in') {
      const x0 = (i - mid) * 18
      keyframes.push({ el, prop: 'x', t: t0, value: x0, ease })
      keyframes.push({ el, prop: 'x', t: t0 + animator.duration, value: 0, ease })
    }
  }
  return { units, keyframes }
}
