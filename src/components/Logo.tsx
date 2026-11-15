import { useId } from 'react'

import { cn } from '@/lib/utils'

/* The Diazo mark ("02 Contact", brand sheet on the canvas page "00 Brand —
   Diazo"): an ink-outline D, the original, and offset bottom-right of it a
   solid signal-blue D, the print. The print knocks a 3-unit gap out of the
   outline where they overlap. One 48-unit box for every size. */
const ORIGINAL = 'M5.5 5.5H15A11.5 11.5 0 0 1 15 28.5H5.5Z'
const PRINT = 'M20.5 17H31A14 14 0 0 1 31 45H20.5A1.5 1.5 0 0 1 19 43.5V18.5A1.5 1.5 0 0 1 20.5 17Z'

/* React ids carry colons, which read as a selector inside url(#…) in some engines */
function useSvgId(prefix: string): string {
  return `${prefix}${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
}

function sizeStyle(size: number | 'fill' | undefined) {
  if (size === undefined) return undefined
  return size === 'fill' ? { width: '100%', height: '100%' } : { width: size, height: size }
}

/** Diazo's mark in colour: the outline takes the text colour (ink in light,
 *  near-white in dark), the print the signal blue (`--diazo-signal`, which
 *  the theme lightens in dark). Size it with a `size-` class or `size`. */
export function Logo({ className = 'size-[30px]', size }: { className?: string; size?: number }) {
  return <DiazoMark tone="color" className={cn('text-ink', className)} size={size} />
}

/** The bare mark, sized like a letter by default (13px tall, on the text
 *  baseline): the glyph that stands for Diazo inline next to text (presence
 *  chips, the model menu, activity rows). `tone="mono"` (the default inline)
 *  paints both Ds in the text colour or `color`; `tone="color"` keeps the
 *  blue print. `animated` plays the reveal once: the outline draws, then the
 *  print lands on it (the home greeting; a plain fade under reduced motion).
 *  `size` is the height in px, or `fill` to take the box a parent sizes. */
export function DiazoMark({
  size = 13,
  color,
  tone,
  animated = false,
  className = 'mr-px inline-block align-[-2px]',
}: {
  size?: number | 'fill'
  color?: string
  tone?: 'mono' | 'color'
  animated?: boolean
  className?: string
}) {
  const mask = useSvgId('diazo-k')
  const colored = (tone ?? (animated ? 'color' : 'mono')) === 'color' && !color
  const ink = color ?? 'currentColor'
  return (
    <svg
      className={cn(animated && 'diazo-reveal', className)}
      /* inline so Button's descendant-svg rule (16px unless a size- class) cannot override it */
      style={sizeStyle(size)}
      viewBox="0 0 48 48"
      data-mark="diazo"
      aria-hidden
    >
      <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="48" height="48">
        <rect width="48" height="48" fill="#fff" />
        <path className="diazo-reveal-gap" d={PRINT} stroke="#000" strokeWidth="6" />
      </mask>
      <path
        className="diazo-reveal-original"
        pathLength={animated ? 1 : undefined}
        d={ORIGINAL}
        fill="none"
        stroke={ink}
        strokeWidth="5"
        strokeLinejoin="round"
        mask={`url(#${mask})`}
      />
      <path className="diazo-reveal-print" d={PRINT} fill={colored ? 'var(--diazo-signal)' : ink} />
    </svg>
  )
}

/* "diazo" set in Familjen Grotesk, outlined, so no font has to load; the
   i's dot is a small print D in the signal blue. Baseline at y 96. */
const WORD =
  'M27.7 1.3Q19.6 1.3 14.3 -2.7Q9 -6.8 6.3 -13.8Q3.6 -20.9 3.6 -30.1Q3.6 -39.5 6.3 -46.5Q9 -53.5 14.4 -57.4Q19.7 -61.3 27.6 -61.3Q33.6 -61.3 37.4 -59.1Q41.1 -56.9 43.2 -53.2H45.7V-80H60.5V0H46.9V-7.8H44.5Q42.5 -4 38.5 -1.4Q34.4 1.3 27.7 1.3ZM31.6 -9.5Q38.1 -9.5 41.9 -15.1Q45.7 -20.7 45.7 -30Q45.7 -39.4 41.9 -45Q38.1 -50.5 31.6 -50.5Q25.7 -50.5 22.3 -45.3Q19 -40.1 19 -30Q19 -19.9 22.3 -14.7Q25.7 -9.5 31.6 -9.5ZM74.4 0V-60H89.2V0ZM124 1.3Q115.8 1.3 110.4 -2.7Q105 -6.8 102.3 -13.8Q99.7 -20.9 99.7 -30.1Q99.7 -39.5 102.4 -46.5Q105.1 -53.5 110.5 -57.4Q115.9 -61.3 124 -61.3Q130.4 -61.3 134.5 -58.7Q138.5 -56.2 140.5 -52.2H142.9V-60H156.6V0H142.9V-7.8H140.5Q138.5 -4 134.5 -1.4Q130.5 1.3 124 1.3ZM127.7 -9.5Q134.1 -9.5 137.9 -15.1Q141.8 -20.7 141.8 -30Q141.8 -39.4 137.9 -45Q134.1 -50.5 127.7 -50.5Q121.7 -50.5 118.4 -45.3Q115 -40.1 115 -30Q115 -19.9 118.4 -14.7Q121.7 -9.5 127.7 -9.5ZM165.4 0V-12.2L188.1 -39.5Q189.9 -41.6 191.6 -43.5Q193.3 -45.5 194.9 -47V-49.4H166.7V-60H212.8V-47.8L190.2 -20.6Q188.5 -18.4 186.8 -16.5Q185.1 -14.7 183.4 -13.1V-10.7H214.1V0ZM248.4 1.5Q233.8 1.5 226.7 -7.1Q219.5 -15.6 219.5 -30Q219.5 -44.4 226.7 -53Q233.8 -61.5 248.4 -61.5Q263 -61.5 270.2 -53Q277.4 -44.4 277.4 -30Q277.4 -15.6 270.2 -7.1Q263 1.5 248.4 1.5ZM248.4 -8.8Q255.5 -8.8 258.8 -14.2Q262 -19.7 262 -30Q262 -40.4 258.8 -45.8Q255.5 -51.2 248.4 -51.2Q241.4 -51.2 238.1 -45.8Q234.8 -40.4 234.8 -30Q234.8 -19.7 238.1 -14.2Q241.4 -8.8 248.4 -8.8Z'
const WORD_DOT = 'M74.4 -89H80.2A9 9 0 0 1 80.2 -71H74.4Z'

/** The word "diazo" alone, in the text colour with the blue dot (`mono`: one
 *  colour). `height` is the box's height in px; the width follows (293:102). */
export function DiazoWordmark({
  height = 18,
  tone = 'color',
  className,
}: {
  height?: number
  tone?: 'mono' | 'color'
  className?: string
}) {
  return (
    <svg
      className={className}
      style={{ height, width: Math.round((height * 293) / 102) }}
      viewBox="0 0 293 102"
      role="img"
      aria-label="Diazo"
      data-mark="diazo-wordmark"
    >
      <g transform="translate(6,96)">
        <path d={WORD} fill="currentColor" />
        <path d={WORD_DOT} fill={tone === 'color' ? 'var(--diazo-signal)' : 'currentColor'} />
      </g>
    </svg>
  )
}

/* The Diazo Agent's two Ds, drawn smaller inside a ringed disc. */
const AGENT_ORIGINAL = 'M15 14H21A8 8 0 0 1 21 30H15Z'
const AGENT_PRINT = 'M22.5 19H28A9.5 9.5 0 0 1 28 38H22.5A1 1 0 0 1 21.5 37V20A1 1 0 0 1 22.5 19Z'

/** The Diazo Agent's face: the two Ds in agent orange (`--diazo-agent`) on a
 *  ringed surface disc. `working` animates it (the ring is chased, the
 *  original redrawn, the print pulses), still under reduced motion.
 *  `solid` is the filled variant: white Ds on a disc of `color` (the agent
 *  orange by default; a role's crew colour on its badge). */
export function DiazoAgentMark({
  size = 24,
  working = false,
  solid = false,
  color,
  className,
}: {
  size?: number | 'fill'
  working?: boolean
  solid?: boolean
  color?: string
  className?: string
}) {
  const mask = useSvgId('diazo-a')
  const accent = color ?? 'var(--diazo-agent)'
  const knockout = (
    <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="48" height="48">
      <rect width="48" height="48" fill="#fff" />
      <path d={AGENT_PRINT} stroke="#000" strokeWidth="5" />
    </mask>
  )
  if (solid) {
    return (
      <svg className={className} style={sizeStyle(size)} viewBox="0 0 48 48" data-mark="diazo-agent" aria-hidden>
        {knockout}
        <circle cx="24" cy="24" r="24" fill={accent} />
        <path
          d={AGENT_ORIGINAL}
          fill="none"
          stroke="#fff"
          strokeWidth="4"
          strokeLinejoin="round"
          mask={`url(#${mask})`}
        />
        <path d={AGENT_PRINT} fill="#fff" />
      </svg>
    )
  }
  return (
    <svg
      className={cn(working && 'diazo-agent-working', className)}
      style={{ ...sizeStyle(size), color: accent }}
      viewBox="0 0 48 48"
      data-mark="diazo-agent"
      data-working={working || undefined}
      aria-hidden
    >
      {knockout}
      <circle cx="24" cy="24" r="23" fill="var(--surface)" />
      <circle className="diazo-agent-ring" cx="24" cy="24" r="22" fill="none" stroke="currentColor" strokeWidth="2" />
      <g mask={`url(#${mask})`}>
        <path
          className="diazo-agent-original"
          d={AGENT_ORIGINAL}
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinejoin="round"
        />
        {working && (
          <path
            className="diazo-agent-trace"
            d={AGENT_ORIGINAL}
            fill="none"
            stroke="currentColor"
            strokeWidth="4"
            strokeLinejoin="round"
          />
        )}
      </g>
      <path className="diazo-agent-print" d={AGENT_PRINT} fill="currentColor" />
      {working && (
        <circle
          className="diazo-agent-chase"
          cx="24"
          cy="24"
          r="22"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          transform="rotate(-90 24 24)"
        />
      )}
    </svg>
  )
}
