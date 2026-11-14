/**
 * Library imports and tokens: literal colours, radii and font families in a
 * frame's CSS that equal a token of the library canvas, listed (`suggest`)
 * or rewritten to `var(--name)` (`apply`). Only CSS is touched: `<style>`
 * blocks and `style=""` attributes, never markup or text.
 */
import { cssColorToRgba } from './slopRules.ts'
import { resolveToken, type DesignToken } from './designTokens.ts'

export interface TokenMatch {
  /** the literal as written */
  value: string
  token: string
  count: number
}

type Kind = 'color' | 'radius' | 'font'

const PROPERTY_KIND: Record<string, Kind> = {
  color: 'color',
  background: 'color',
  'background-color': 'color',
  'border-color': 'color',
  border: 'color',
  'border-top-color': 'color',
  'border-bottom-color': 'color',
  'border-left-color': 'color',
  'border-right-color': 'color',
  outline: 'color',
  'outline-color': 'color',
  fill: 'color',
  stroke: 'color',
  'box-shadow': 'color',
  'text-decoration-color': 'color',
  'caret-color': 'color',
  'accent-color': 'color',
  'border-radius': 'radius',
  'font-family': 'font',
}

const COLOR_LITERAL = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi
const LENGTH_LITERAL = /\b\d+(?:\.\d+)?(?:px|rem|em)\b/g

function colorKey(value: string): string | null {
  const rgba = cssColorToRgba(value.trim())
  return rgba ? `${Math.round(rgba.r)},${Math.round(rgba.g)},${Math.round(rgba.b)},${+rgba.a.toFixed(3)}` : null
}

const normFont = (value: string) =>
  value
    .split(',')
    .map((f) =>
      f
        .trim()
        .replace(/^["']|["']$/g, '')
        .toLowerCase(),
    )
    .join(',')

/** The library's tokens by kind, keyed by their normalised value. */
function tokenTable(tokens: readonly DesignToken[]) {
  const table: Record<Kind, Map<string, string>> = { color: new Map(), radius: new Map(), font: new Map() }
  for (const token of tokens) {
    const value = resolveToken(tokens, token.name) ?? token.value
    if (token.type === 'color') {
      const key = colorKey(value)
      if (key && !table.color.has(key)) table.color.set(key, token.name)
    } else if (token.type === 'radius') {
      if (!table.radius.has(value.trim())) table.radius.set(value.trim(), token.name)
    } else if (token.type === 'fontFamily') {
      if (!table.font.has(normFont(value))) table.font.set(normFont(value), token.name)
    }
  }
  return table
}

interface Declaration {
  /** where the value starts and ends in the html */
  start: number
  end: number
  property: string
  value: string
}

/** Every declaration in the CSS a frame holds: its `<style>` blocks and
 *  its `style=""` attributes, with source offsets. */
function declarations(html: string): Declaration[] {
  const out: Declaration[] = []
  const scan = (css: string, base: number) => {
    const re = /([a-z-]+)\s*:\s*([^;{}"]+)/gi
    for (const m of css.matchAll(re)) {
      const property = m[1]!.toLowerCase()
      if (!(property in PROPERTY_KIND)) continue
      const valueAt = (m.index ?? 0) + m[0].indexOf(m[2]!, m[1]!.length)
      out.push({ start: base + valueAt, end: base + valueAt + m[2]!.length, property, value: m[2]! })
    }
  }
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    scan(m[1]!, (m.index ?? 0) + m[0].indexOf(m[1]!))
  }
  for (const m of html.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)) {
    scan(m[1]!, (m.index ?? 0) + m[0].indexOf('"') + 1)
  }
  return out
}

interface Replacement {
  start: number
  end: number
  literal: string
  token: string
}

/** The literals of one declaration that equal a token. A colour inside a
 *  `url()` or in a gradient's stop list is left alone, unless the stop is
 *  the colour alone. */
function replacementsIn(decl: Declaration, table: ReturnType<typeof tokenTable>): Replacement[] {
  const kind = PROPERTY_KIND[decl.property]!
  const value = decl.value
  if (kind === 'font') {
    const token = table.font.get(normFont(value))
    return token ? [{ start: decl.start, end: decl.end, literal: value.trim(), token }] : []
  }
  if (/url\(/i.test(value)) return []
  const out: Replacement[] = []
  const re = kind === 'color' ? COLOR_LITERAL : LENGTH_LITERAL
  for (const m of value.matchAll(re)) {
    const literal = m[0]
    if (kind === 'color' && /gradient\(/i.test(value)) {
      /* a stop is "<colour> <position>?": only a bare colour between commas is a whole stop */
      const before = value.slice(0, m.index).trimEnd()
      const after = value.slice((m.index ?? 0) + literal.length).trimStart()
      if (!(/[,(]$/.test(before) && /^[,)]/.test(after))) continue
    }
    const token = kind === 'color' ? table.color.get(colorKey(literal) ?? '') : table.radius.get(literal)
    if (!token) continue
    const start = decl.start + (m.index ?? 0)
    out.push({ start, end: start + literal.length, literal, token })
  }
  return out
}

function allReplacements(html: string, tokens: readonly DesignToken[]): Replacement[] {
  const table = tokenTable(tokens)
  return declarations(html).flatMap((d) => replacementsIn(d, table))
}

/** The literals equal to a token, counted. */
export function tokenMatches(html: string, tokens: readonly DesignToken[]): TokenMatch[] {
  const counts = new Map<string, TokenMatch>()
  for (const r of allReplacements(html, tokens)) {
    const key = `${r.literal.toLowerCase()}\n${r.token}`
    const known = counts.get(key)
    if (known) known.count++
    else counts.set(key, { value: r.literal, token: r.token, count: 1 })
  }
  return [...counts.values()]
}

/** Rewrite those literals to `var(--token)`, in CSS only. */
export function applyTokenMatches(html: string, tokens: readonly DesignToken[]): string {
  const edits = allReplacements(html, tokens).sort((a, b) => b.start - a.start)
  let out = html
  for (const e of edits) out = `${out.slice(0, e.start)}var(${e.token})${out.slice(e.end)}`
  return out
}
