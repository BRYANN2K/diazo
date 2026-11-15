import type { Meta, StoryObj } from '@storybook/react-vite'
import { cn } from '@/lib/utils'

/**
 * The tokens every component is built from, read live from the stylesheet
 * so a token change shows up here before anyone touches a component.
 */
const meta = { title: 'Foundations' } satisfies Meta
export default meta

type Story = StoryObj<typeof meta>

const COLOURS: { token: string; cls: string; role: string }[] = [
  { token: '--ground', cls: 'bg-ground', role: 'the stage and the app backdrop (the bench)' },
  { token: '--paper', cls: 'bg-paper', role: 'a page' },
  { token: '--surface', cls: 'bg-surface', role: 'islands, cards, menus' },
  { token: '--well', cls: 'bg-well', role: 'filled fields, a hovered or pressed row' },
  { token: '--line', cls: 'bg-line', role: 'the 1px ring on controls and islands' },
  { token: '--ink', cls: 'bg-ink', role: 'text, the primary button' },
  { token: '--ink-2', cls: 'bg-ink-2', role: 'secondary text, icons' },
  { token: '--ink-3', cls: 'bg-ink-3', role: 'captions, timestamps, counts' },
  { token: '--signal', cls: 'bg-signal', role: 'people and selection, focus' },
  { token: '--agent', cls: 'bg-agent', role: 'anything an agent does (never alone: mark + beam)' },
  { token: '--ok', cls: 'bg-ok', role: 'connected, passed, done' },
  { token: '--caution', cls: 'bg-caution', role: 'hover or a selected frame only' },
  { token: '--danger', cls: 'bg-danger', role: 'failure, always with icon and text' },
]

export const Colours: Story = {
  render: () => (
    <div className="grid max-w-[720px] grid-cols-1 gap-2 sm:grid-cols-2">
      {COLOURS.map((c) => (
        <div key={c.token} className="flex items-center gap-3 rounded-card bg-surface p-2.5 shadow-ring">
          <span className={cn('size-9 flex-none rounded-control shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08)]', c.cls)} />
          <span className="min-w-0">
            <span className="block font-mono text-label text-ink">{c.token}</span>
            <span className="block text-caption text-ink-faint">{c.role}</span>
          </span>
        </div>
      ))}
    </div>
  ),
}

const STEPS: { cls: string; px: string; role: string }[] = [
  { cls: 'text-display font-display', px: '44', role: 'the home greeting' },
  { cls: 'text-title font-display', px: '28', role: 'page titles' },
  { cls: 'text-heading font-display', px: '20', role: 'card and dialog headings' },
  { cls: 'text-lead', px: '15', role: 'ledes, the composer placeholder' },
  { cls: 'text-copy', px: '13.5', role: 'prose in cards and dialogs' },
  { cls: 'text-body', px: '12.5', role: 'the chrome: rows, buttons, chips, menus' },
  { cls: 'text-label', px: '12', role: 'chrome labels, field labels' },
  { cls: 'text-caption', px: '11', role: 'timestamps, counts, hints, badges' },
  { cls: 'text-micro', px: '10.5', role: 'key caps, mono captions' },
]

const FACES = [
  {
    token: '--font-ui',
    cls: 'font-sans',
    family: 'Atkinson Hyperlegible Next',
    weights: '400 · 500 · 600',
    role: 'Everything the chrome says: labels, rows, buttons. It runs wide, so the chrome is 12.5px with -0.005em tracking and labels never wrap.',
    sample: 'Ask Diazo what to design',
  },
  {
    token: '--font-mono',
    cls: 'font-mono',
    family: 'Atkinson Hyperlegible Mono',
    weights: '400 · 500',
    role: 'Values only: ids, sizes, coordinates, key caps, code, costs. Never a caption, never uppercase.',
    sample: '1440 × 900 · #1f5fff · ⌘K · 5BNZaqaASa',
  },
  {
    token: '--font-display / --font-hero',
    cls: 'font-display tracking-[-0.03em]',
    family: 'Familjen Grotesk',
    weights: '500 · 600 · 700',
    role: 'Headings from 20px up: card and dialog titles, page titles, the home greeting. Never below 20px.',
    sample: 'Ask Diazo what to design',
  },
] as const

/** The three faces the product is set in (direction B, Hyperlegible), self-hosted from src/assets/fonts. */
export const Typefaces: Story = {
  render: () => (
    <div className="flex max-w-[760px] flex-col gap-5">
      {FACES.map((f) => (
        <div key={f.token} className="flex flex-col gap-2 border-b border-line-soft pb-5">
          <span className={cn(f.cls, 'text-title text-ink')}>{f.sample}</span>
          <span className={cn(f.cls, 'text-copy text-ink-soft')}>
            The quick brown fox jumps over the lazy dog · 0123456789
          </span>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-caption text-ink-faint">
            <span className="font-mono">{f.token}</span>
            <span className="text-ink-soft">{f.family}</span>
            <span>{f.weights}</span>
          </div>
          <p className="max-w-[60ch] text-caption text-ink-faint">{f.role}</p>
        </div>
      ))}
      <p className="text-caption text-ink-faint">
        Retired: Inter, Geist Mono and Hanken Grotesk. Numbers are tabular everywhere.
      </p>
    </div>
  ),
}

export const TypeScale: Story = {
  name: 'Type scale',
  render: () => (
    <div className="flex max-w-[760px] flex-col gap-4">
      {STEPS.map((s) => (
        <div key={s.cls} className="flex items-baseline gap-4 border-b border-line-soft pb-3">
          <span className="w-[120px] flex-none font-mono text-caption text-ink-faint">
            {s.cls}
            <br />
            {s.px}px
          </span>
          <span className={cn(s.cls, 'min-w-0 flex-1 truncate text-ink')}>Ask me what to design</span>
          <span className="hidden w-[220px] flex-none text-caption text-ink-faint sm:block">{s.role}</span>
        </div>
      ))}
      <p className="text-caption text-ink-faint">
        Weights: 400 for text, 500 for labels, buttons and emphasis, 600 for card and modal headings only.
      </p>
    </div>
  ),
}

const RADII = [
  ['rounded-tag', '4px', 'badges, checkbox squares'],
  ['rounded-control', '7px', 'buttons and fields'],
  ['rounded-row', '8px', 'list, menu and rail rows'],
  ['rounded-pill', '999px', 'chips'],
  ['rounded-card', '12px', 'cards and tiles'],
  ['rounded-panel', '14px', 'floating islands'],
  ['rounded-sheet', '20px', 'dialogs'],
] as const

const SHADOWS = [
  ['shadow-ring', 'elevation 1: a resting control'],
  ['shadow-panel', 'elevation 2: an island over the stage'],
  ['shadow-pop', 'elevation 3: a menu or toast'],
  ['shadow-modal', 'elevation 4: a dialog'],
] as const

export const ShapeAndDepth: Story = {
  name: 'Shape & depth',
  render: () => (
    <div className="flex max-w-[760px] flex-col gap-8">
      <div className="flex flex-wrap gap-4">
        {RADII.map(([cls, px, role]) => (
          <div key={cls} className="flex flex-col items-center gap-2">
            <span className={cn('size-16 bg-surface shadow-ring', cls)} />
            <span className="font-mono text-caption text-ink">{cls}</span>
            <span className="text-caption text-ink-faint">
              {px} · {role}
            </span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-6">
        {SHADOWS.map(([cls, role]) => (
          <div key={cls} className="flex flex-col items-center gap-2">
            <span className={cn('h-16 w-24 rounded-card bg-surface', cls)} />
            <span className="font-mono text-caption text-ink">{cls}</span>
            <span className="text-caption text-ink-faint">{role}</span>
          </div>
        ))}
      </div>
    </div>
  ),
}

const DURATIONS = [
  ['--dur-instant', '80ms', 'hover in, an active row'],
  ['--dur-fast', '140ms', 'hover out, press'],
  ['--dur-base', '200ms', 'enters, a tab glide'],
  ['--dur-slow', '280ms', 'panels, a shared expand'],
  ['--dur-slower', '420ms', 'a number roll'],
] as const

const CURVES = [
  ['ease-out', 'enter'],
  ['ease-in-out', 'move between two states'],
  ['ease-exit', 'leave, at 70% of the enter time'],
  ['ease-spring-soft', 'dialogs, toasts (400ms)'],
  ['ease-spring-snap', 'segmented pill, chips (320ms)'],
  ['ease-spring-pop', 'something landing (450ms)'],
] as const

/** The motion tokens: hover a row to replay its curve. Under reduced motion every move becomes a short fade. */
export const Motion: Story = {
  render: () => (
    <div className="flex max-w-[760px] flex-col gap-6">
      <div className="flex flex-col gap-2">
        {DURATIONS.map(([token, ms, role]) => (
          <div key={token} className="flex items-baseline gap-4 border-b border-line-soft pb-2">
            <span className="w-[140px] flex-none font-mono text-caption text-ink">{token}</span>
            <span className="w-[60px] flex-none font-mono text-caption text-ink-2">{ms}</span>
            <span className="text-caption text-ink-3">{role}</span>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        {CURVES.map(([curve, role]) => (
          <div key={curve} className="group flex items-center gap-4 rounded-row px-2 py-1.5 hover:bg-well">
            <span className="w-[140px] flex-none font-mono text-caption text-ink">{curve}</span>
            <span className="relative h-2 flex-1 rounded-pill bg-well">
              <span
                className={cn(
                  'absolute top-0 left-0 size-2 rounded-pill bg-signal transition-[left] duration-slower group-hover:left-[calc(100%-8px)]',
                  curve,
                )}
              />
            </span>
            <span className="w-[200px] flex-none text-caption text-ink-3">{role}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <span className="shimmer-text text-body font-medium">Reading the Pricing frame…</span>
        <span className="agent-beam h-10 w-24 rounded-row bg-surface shadow-ring" />
      </div>
    </div>
  ),
}
