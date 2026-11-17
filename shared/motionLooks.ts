/**
 * shared/motionLooks.ts — named looks (motion-pro P1). A look is a curated
 * effect stack applied to an adjustment track: the recipe lives here once
 * so `apply_look`, the registry and a future gallery all agree on what
 * "teal-orange" means. Stacks use registry ids — nothing bespoke — so a
 * look stays editable as ordinary effects afterwards.
 */

import type { EffectInstance } from './motion.ts'

export interface MotionLook {
  id: string
  label: string
  /** one line — the mood it gives and when to reach for it */
  note: string
  /** the stack an adjustment track gets: (fx, params) pairs */
  stack: readonly { fx: string; params?: Record<string, number | string | boolean> }[]
}

export const MOTION_LOOKS: readonly MotionLook[] = [
  {
    id: 'teal-orange',
    label: 'Teal & Orange',
    note: 'the blockbuster split — cool shadows, warm skin-lit highlights',
    stack: [
      {
        fx: 'color-grade',
        params: { contrast: 0.12, saturation: 0.08, shadows: '#0d2b33', highlights: '#f0a35e', split: 0.5 },
      },
      { fx: 'vignette', params: { amount: 0.25, feather: 0.7 } },
    ],
  },
  {
    id: 'noir',
    label: 'Noir',
    note: 'crushed blacks, hard contrast, silver grain — a night film',
    stack: [
      { fx: 'color-grade', params: { contrast: 0.35, saturation: -1, exposure: -0.15 } },
      { fx: 'film-grain', params: { amount: 0.2, size: 1.2, mono: true } },
      { fx: 'vignette', params: { amount: 0.5, feather: 0.5 } },
    ],
  },
  {
    id: 'film-35',
    label: '35mm Film',
    note: 'warm print stock — soft highlight rolloff, grain and a gate weave',
    stack: [
      { fx: 'curves', params: { black: 0.06, white: 0.94, gamma: 1.05 } },
      { fx: 'color-grade', params: { temperature: 0.18, saturation: -0.1 } },
      { fx: 'film-grain', params: { amount: 0.14, size: 1.6, mono: true } },
      { fx: 'halftone', params: { size: 40, softness: 0.9 } },
    ],
  },
  {
    id: 'crt',
    label: 'CRT',
    note: 'a phosphor screen — scanlines, barrel, a faint chroma fringe',
    stack: [
      { fx: 'scanlines', params: { count: 480, opacity: 0.28 } },
      { fx: 'barrel-distortion', params: { amount: 0.08 } },
      { fx: 'chromatic-aberration', params: { amount: 1.5 } },
      { fx: 'bloom', params: { threshold: 0.6, intensity: 0.35 } },
    ],
  },
  {
    id: 'glitch',
    label: 'Glitch',
    note: 'signal damage — channel split, block tears, scan wobble',
    stack: [
      { fx: 'rgb-split', params: { amount: 8, jitter: 0.4 } },
      { fx: 'block-shift', params: { amount: 28, rows: 16, rate: 5 } },
      { fx: 'scan-jitter', params: { amount: 4, frequency: 90 } },
    ],
  },
  {
    id: 'dream',
    label: 'Dream',
    note: 'halation and softness — the flashback look',
    stack: [
      { fx: 'glow', params: { radius: 30, intensity: 0.7, threshold: 0.5, tint: '#ffe9c8' } },
      { fx: 'gaussian-blur', params: { radius: 1.5 } },
      { fx: 'color-grade', params: { temperature: 0.1, saturation: -0.05, exposure: 0.05 } },
      { fx: 'vignette', params: { amount: 0.35, feather: 0.8 } },
    ],
  },
  {
    id: 'product',
    label: 'Product',
    note: 'a clean studio frame — crisp, neutral, slight lift',
    stack: [
      { fx: 'color-grade', params: { contrast: 0.08, saturation: 0.05, exposure: 0.08 } },
      { fx: 'vignette', params: { amount: 0.12, feather: 0.85 } },
    ],
  },
  {
    id: 'riso',
    label: 'Riso Print',
    note: 'duotone ink on paper — posterized, grained, slightly misregistered',
    stack: [
      { fx: 'duotone', params: { shadow: '#173a5e', highlight: '#ff7a59', amount: 1 } },
      { fx: 'posterize', params: { levels: 7 } },
      { fx: 'noise', params: { amount: 0.08, scale: 2, mono: true } },
      { fx: 'rgb-split', params: { amount: 1.5 } },
    ],
  },
]

/** the stack instances an adjustment track gets — fresh ids per call so two
 *  applications never share instance ids on one composition */
export function lookEffects(lookId: string, mint: () => string = defaultMint): EffectInstance[] | undefined {
  const look = MOTION_LOOKS.find((l) => l.id === lookId)
  if (!look) return undefined
  return look.stack.map((entry, i) => ({
    id: `${look.id}-${i + 1}-${mint()}`,
    fx: entry.fx,
    params: { ...(entry.params ?? {}) },
  }))
}

let counter = 0
const defaultMint = () => (++counter).toString(36)
