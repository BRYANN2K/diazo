import type { CompositionStateAt } from './contract'

/* An element track's resolved values (shared/motionRuntime.ts
   `frameStateAt(...).elements`) as CSS for its element, keyed by
   `data-doop-id`. Transform parts use the individual `translate`, `scale`
   and `rotate` properties so the element's own `transform` still applies;
   the rules are `!important` because a frame styles its elements inline. */

const num = (v: number | string | undefined): number | undefined => {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

function declarations(props: Record<string, number | string>): string[] {
  const out: string[] = []
  const x = num(props.x)
  const y = num(props.y)
  if (x !== undefined || y !== undefined) out.push(`translate: ${x ?? 0}px ${y ?? 0}px`)
  const scale = num(props.scale)
  const sx = num(props.scaleX)
  const sy = num(props.scaleY)
  if (scale !== undefined || sx !== undefined || sy !== undefined)
    out.push(`scale: ${sx ?? scale ?? 1} ${sy ?? scale ?? 1}`)
  const rotate = num(props.rotate)
  if (rotate !== undefined) out.push(`rotate: ${rotate}deg`)
  const skewX = num(props.skewX)
  const skewY = num(props.skewY)
  if (skewX !== undefined || skewY !== undefined) out.push(`transform: skew(${skewX ?? 0}deg, ${skewY ?? 0}deg)`)
  const opacity = num(props.opacity)
  if (opacity !== undefined) out.push(`opacity: ${Math.min(1, Math.max(0, opacity))}`)
  const filters: string[] = []
  const blur = num(props.blur)
  if (blur !== undefined) filters.push(`blur(${blur}px)`)
  for (const name of ['brightness', 'contrast', 'saturate', 'grayscale'] as const) {
    const v = num(props[name])
    if (v !== undefined) filters.push(`${name}(${v})`)
  }
  const hue = num(props['hue-rotate'])
  if (hue !== undefined) filters.push(`hue-rotate(${hue}deg)`)
  if (filters.length) out.push(`filter: ${filters.join(' ')}`)
  const radius = num(props.borderRadius)
  if (radius !== undefined) out.push(`border-radius: ${radius}px`)
  if (typeof props.color === 'string') out.push(`color: ${props.color}`)
  if (typeof props.backgroundColor === 'string') out.push(`background-color: ${props.backgroundColor}`)
  for (const [name, value] of Object.entries(props)) if (name.startsWith('--')) out.push(`${name}: ${value}`)
  return out.map((d) => `${d} !important`)
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/

/** The CSS one frame needs at this instant, '' when no track touches it. */
export function frameMotionCss(state: CompositionStateAt, frameId: string): string {
  const prefix = `${frameId}/`
  const rules: string[] = []
  for (const [key, props] of Object.entries(state.elements)) {
    if (!key.startsWith(prefix)) continue
    const elementId = key.slice(prefix.length)
    if (!SAFE_ID.test(elementId)) continue
    const body = declarations(props)
    if (body.length) rules.push(`[data-doop-id="${elementId}"] { ${body.join('; ')} }`)
  }
  return rules.join('\n')
}

/** the frames an element track of this state touches */
export function animatedFrames(state: CompositionStateAt): Set<string> {
  return new Set(Object.keys(state.elements).map((key) => key.split('/')[0] ?? ''))
}
