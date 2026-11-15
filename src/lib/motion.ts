import { useSyncExternalStore } from 'react'

/**
 * The motion tokens of the redesign (canvas "redoop — Redesign 2026-11",
 * guideline redoop-build-notes), for code that animates from script: Web
 * Animations, a FLIP, a number roll. CSS reads the same values from the
 * custom properties in src/styles.css (`--dur-*`, `--ease-*`, `--spring-*`);
 * keep the two in step.
 */
export const DURATION = {
  /** hover in, an active row */
  instant: 80,
  /** hover out, press */
  fast: 140,
  /** most enters, a tab glide */
  base: 200,
  /** a panel, a shared expand */
  slow: 280,
  /** a number roll, a long move */
  slower: 420,
} as const

export type DurationName = keyof typeof DURATION

/** delay between two items of a list entering, for the first eight */
export const STAGGER_MS = 30
export const STAGGER_MAX_ITEMS = 8

export const EASE = {
  out: 'cubic-bezier(0.22, 1, 0.36, 1)',
  inOut: 'cubic-bezier(0.65, 0, 0.35, 1)',
  exit: 'cubic-bezier(0.4, 0, 0.6, 1)',
} as const

const soft = [
  0, 0.047, 0.156, 0.29, 0.427, 0.555, 0.666, 0.757, 0.83, 0.887, 0.928, 0.958, 0.979, 0.992, 1.001, 1.005, 1.008,
  1.008, 1.007, 1.005, 1.003, 1,
]
const snap = [
  0, 0.049, 0.157, 0.285, 0.411, 0.525, 0.624, 0.706, 0.772, 0.825, 0.866, 0.899, 0.924, 0.943, 0.957, 0.968, 0.976,
  0.982, 0.987, 0.99, 0.993, 0.996, 1,
]
const pop = [
  0, 0.042, 0.142, 0.274, 0.414, 0.549, 0.67, 0.774, 0.858, 0.922, 0.97, 1.002, 1.023, 1.035, 1.039, 1.039, 1.036,
  1.031, 1.026, 1.02, 1.015, 1.011, 1.007, 1.004, 1,
]

/** A spring is a linear() easing and the duration it was sampled for. */
export interface Spring {
  easing: string
  duration: number
}

export const SPRING = {
  /** enters: dialogs, toasts, the shared expand */
  soft: { easing: `linear(${soft.join(', ')})`, duration: 400 },
  /** selections: segmented pill, chips joining the composer */
  snap: { easing: `linear(${snap.join(', ')})`, duration: 320 },
  /** something landing: a kept duel result, a re-anchored pin */
  pop: { easing: `linear(${pop.join(', ')})`, duration: 450 },
} as const satisfies Record<string, Spring>

export type SpringName = keyof typeof SPRING

/** An exit takes 70% of its enter's time, on the exit curve, never overshooting. */
export function exitDuration(enterMs: number): number {
  return Math.round(enterMs * 0.7)
}

/** The delay of item `index` in a staggered list (the eighth and later share one). */
export function staggerDelay(index: number): number {
  return Math.min(Math.max(index, 0), STAGGER_MAX_ITEMS - 1) * STAGGER_MS
}

const QUERY = '(prefers-reduced-motion: reduce)'

function mediaQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  return window.matchMedia(QUERY)
}

/** Whether the person asked the system for reduced motion, right now. */
export function prefersReducedMotion(): boolean {
  return mediaQuery()?.matches ?? false
}

function subscribe(onChange: () => void): () => void {
  const query = mediaQuery()
  if (!query) return () => {}
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

/** The reduced-motion preference, following it live. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false)
}

/**
 * Options for `element.animate()` that honour reduced motion: the full move
 * normally, a 120ms opacity-only fade under reduced motion (pass `fade` to
 * get the keyframes to swap to).
 */
export function motionOptions(
  timing: Spring | { duration: number; easing: string },
  extra: KeyframeAnimationOptions = {},
): KeyframeAnimationOptions {
  if (prefersReducedMotion()) return { ...extra, duration: 120, easing: 'linear', delay: 0 }
  return { ...extra, duration: timing.duration, easing: timing.easing }
}

/**
 * Animate an element between keyframes with the system's timing; under reduced
 * motion the transform keyframes are dropped and only opacity changes, or
 * nothing happens when no keyframe changes opacity.
 */
export function animate(
  element: Element,
  keyframes: Keyframe[],
  timing: Spring | { duration: number; easing: string },
  extra: KeyframeAnimationOptions = {},
): Animation | null {
  if (typeof element.animate !== 'function') return null
  if (prefersReducedMotion()) {
    const fades = keyframes.map((frame) => ('opacity' in frame ? { opacity: frame.opacity } : {}))
    if (!fades.some((frame) => 'opacity' in frame)) return null
    return element.animate(fades, motionOptions(timing, extra))
  }
  return element.animate(keyframes, motionOptions(timing, extra))
}
