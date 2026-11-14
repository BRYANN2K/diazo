/**
 * Two-way token sync between a canvas and its linked repo. Repo → doop:
 * the CSS custom properties a project declares (`:root`, Tailwind v4's
 * `@theme`, dark-mode blocks as a theme) and a Tailwind v3 config's
 * `theme` object are parsed — never evaluated — into tokens, then diffed
 * against the canvas's. Doop → repo: the canvas's values become a unified
 * patch against the CSS files the tokens came from (shared/patch.ts), which
 * only the desktop app's `repo_apply_patch` writes, after its own dialog.
 */
import { TOKEN_NAMESPACE, isTokenName, type DesignToken, type TokenType } from './designTokens.ts'

/** Files the repo side reads: style sheets and Tailwind configs. */
export const TOKEN_CSS_GLOB = /\.(css|scss|pcss|postcss)$/i
export const TAILWIND_CONFIG = /(^|\/)tailwind\.config\.(js|cjs|mjs|ts|cts|mts)$/
/** How many style files one sync reads (one repo_read call). */
export const TOKEN_SYNC_MAX_FILES = 12

/** One token as the repo declares it. */
export interface RepoToken {
  name: string
  type: TokenType
  value: string
  /** values under a theme block (`.dark`, `[data-theme="dark"]`, a dark media query) */
  themes?: Record<string, string>
  /** where the default value is declared — the patch edits that line */
  file: string
  line: number
  /** where each theme value is declared */
  themeLines?: Record<string, number>
  origin: 'css' | 'tailwind'
}

/* ------------------------------------------------------------------ */
/* type inference                                                      */
/* ------------------------------------------------------------------ */

/** Namespaces sorted longest first, so `--font-weight-` wins over `--font-`. */
const NAMESPACES = (Object.entries(TOKEN_NAMESPACE) as [TokenType, string][]).sort((a, b) => b[1].length - a[1].length)

/** Common prefixes outside Tailwind's namespaces, shadcn's among them. */
const LOOSE_PREFIXES: [RegExp, TokenType][] = [
  [
    /^--(colou?rs?|bg|background|foreground|fg|border|ring|accent|primary|secondary|muted|destructive|card|popover|input|surface|ink|brand)(-|$)/,
    'color',
  ],
  [/^--(radius|rounded)(-|$)/, 'radius'],
  [/^--(space|spacing|gap|size)(-|$)/, 'spacing'],
  [/^--(font-size|fs|text)(-|$)/, 'fontSize'],
  [/^--(font|family|ff)(-|$)/, 'fontFamily'],
  [/^--(leading|line-height|lh)(-|$)/, 'lineHeight'],
  [/^--(tracking|letter-spacing)(-|$)/, 'letterSpacing'],
]

/** shadcn's bare channels: `222.2 84% 4.9%` */
const HSL_CHANNELS = /^\d+(\.\d+)?\s+\d+(\.\d+)?%\s+\d+(\.\d+)?%(\s*\/\s*[\d.]+%?)?$/
const LENGTH_VALUE = /^-?\d*\.?\d+(px|rem|em|%|vh|vw|ch)?$/

/** The token type a repo variable is, or null when it is not a design value. */
export function inferTokenType(name: string, value: string): TokenType | null {
  for (const [type, prefix] of NAMESPACES) if (name.startsWith(prefix) && name.length > prefix.length) return type
  for (const [re, type] of LOOSE_PREFIXES) if (re.test(name)) return type
  const v = value.trim()
  if (/^#[0-9a-f]{3,8}$/i.test(v) || /^(rgb|rgba|hsl|hsla|oklch|oklab)\(/i.test(v) || HSL_CHANNELS.test(v))
    return 'color'
  if (LENGTH_VALUE.test(v) && v !== '0') return 'spacing'
  return null
}

/* ------------------------------------------------------------------ */
/* CSS                                                                 */
/* ------------------------------------------------------------------ */

/** Comments blanked out, newlines kept, so offsets still map to lines. */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
}

/**
 * The theme a block's selector chain declares tokens for: '' for the
 * defaults (`:root`, `html`, `:host`, `@theme`), a theme name for a theme
 * block, or null for anything else (component-scoped variables).
 */
export function themeOfSelector(chain: readonly string[]): string | null {
  let theme = ''
  let rooted = false
  for (const raw of chain) {
    const sel = raw.trim()
    if (/^@theme\b/.test(sel)) {
      rooted = true
      continue
    }
    if (/^@media\b/.test(sel)) {
      if (/prefers-color-scheme\s*:\s*dark/.test(sel)) theme = 'dark'
      else if (!/prefers-color-scheme/.test(sel)) return null
      continue
    }
    if (/^@(layer|supports)\b/.test(sel)) continue
    if (sel.startsWith('@')) return null
    /* a selector list counts when every member is a root or a theme switch */
    let listTheme: string | null | undefined
    for (const part of sel.split(',').map((p) => p.trim())) {
      const one = themeOfOne(part)
      if (one === null) return null
      if (listTheme === undefined) listTheme = one
      else if (listTheme !== one) return null
    }
    if (listTheme) theme = listTheme
    rooted = true
  }
  return rooted ? theme : null
}

function themeOfOne(sel: string): string | null {
  const s = sel.replace(/\s+/g, ' ')
  if (/^(:root|html|:host|body)$/.test(s)) return ''
  const attr = /^(?:(?::root|html|body)\s*)?\[data-(?:doop-)?theme\s*=\s*["']?([a-z0-9-]+)["']?\]$/i.exec(s)
  if (attr) return attr[1]!.toLowerCase()
  /* `.dark`, `.light`, `.theme-x`, or any class pinned on the root: `:root.x` */
  const rooted = /^(?::root|html|body)\.([a-z][a-z0-9-]*)$/i.exec(s)
  if (rooted) return rooted[1]!.toLowerCase().replace(/^theme-/, '')
  const bare = /^\.(dark|light|theme-[a-z0-9-]+)$/i.exec(s)
  if (bare) return bare[1]!.toLowerCase().replace(/^theme-/, '')
  return null
}

const lineAt = (text: string, offset: number) => {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

/** Every token declared in one style sheet. Later declarations win, like CSS. */
export function parseCssTokens(css: string, file: string): RepoToken[] {
  const text = stripCssComments(css)
  const tokens = new Map<string, RepoToken>()
  const stack: string[] = []
  let selectorStart = 0
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') {
      stack.push(text.slice(selectorStart, i).trim().split(';').pop()!.trim())
      depth++
      selectorStart = i + 1
    } else if (ch === '}') {
      if (depth > 0) {
        readDeclarations(text, selectorStart, i, stack, file, tokens)
        stack.pop()
        depth--
      }
      selectorStart = i + 1
    } else if (ch === ';' && depth > 0) {
      readDeclarations(text, selectorStart, i + 1, stack, file, tokens)
      selectorStart = i + 1
    }
  }
  return [...tokens.values()]
}

function readDeclarations(
  text: string,
  from: number,
  to: number,
  chain: readonly string[],
  file: string,
  tokens: Map<string, RepoToken>,
) {
  const theme = themeOfSelector(chain)
  if (theme === null) return
  const chunk = text.slice(from, to)
  const re = /(--[a-zA-Z0-9_-]+)\s*:\s*([^;{}]*?)\s*(?:;|$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(chunk))) {
    const name = m[1]!
    const value = m[2]!.replace(/\s*!important$/, '').trim()
    if (!value || !isTokenName(name)) continue
    const line = lineAt(text, from + m.index)
    const existing = tokens.get(name)
    if (theme) {
      if (existing) {
        existing.themes = { ...existing.themes, [theme]: value }
        existing.themeLines = { ...existing.themeLines, [theme]: line }
      } else {
        const type = inferTokenType(name, value)
        if (!type) continue
        /* a theme value with no default yet: the default arrives later or never */
        tokens.set(name, {
          name,
          type,
          value: '',
          themes: { [theme]: value },
          themeLines: { [theme]: line },
          file,
          line: 0,
          origin: 'css',
        })
      }
      continue
    }
    const type = existing?.type ?? inferTokenType(name, value)
    if (!type) continue
    tokens.set(name, { ...existing, name, type, value, file, line, origin: 'css' })
  }
}

/* ------------------------------------------------------------------ */
/* Tailwind v3 config — a literal parse, never an eval                 */
/* ------------------------------------------------------------------ */

type Lit = string | number | Lit[] | { [key: string]: Lit } | undefined

/** A tiny tokenizer + parser for the object literals a Tailwind config
 *  holds. Anything not literal — calls, spreads, references — reads as
 *  undefined and is skipped, so a config can never run code here. */
class LiteralParser {
  private i = 0
  constructor(private readonly src: string) {}

  private ws() {
    for (;;) {
      const rest = this.src.slice(this.i)
      const m = /^(\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)/.exec(rest)
      if (!m) return
      this.i += m[0].length
    }
  }

  private peek(): string {
    this.ws()
    return this.src[this.i] ?? ''
  }

  /** Skip one balanced expression we do not understand. */
  private skipExpr() {
    let depth = 0
    for (; this.i < this.src.length; this.i++) {
      const ch = this.src[this.i]!
      if (ch === '"' || ch === "'" || ch === '`') {
        this.str()
        this.i--
        continue
      }
      if ('([{'.includes(ch)) depth++
      else if (')]}'.includes(ch)) {
        if (depth === 0) return
        depth--
      } else if (ch === ',' && depth === 0) return
    }
  }

  private str(): string | undefined {
    const q = this.src[this.i]!
    let out = ''
    this.i++
    for (; this.i < this.src.length; this.i++) {
      const ch = this.src[this.i]!
      if (ch === '\\') {
        out += this.src[++this.i] ?? ''
        continue
      }
      if (ch === q) {
        this.i++
        return q === '`' && out.includes('${') ? undefined : out
      }
      out += ch
    }
    return undefined
  }

  value(): Lit {
    const ch = this.peek()
    if (ch === '{') return this.obj()
    if (ch === '[') return this.arr()
    if (ch === '"' || ch === "'" || ch === '`') return this.str()
    const num = /^-?\d*\.?\d+/.exec(this.src.slice(this.i))
    if (num && !/^[\w$]/.test(this.src.slice(this.i + num[0].length))) {
      this.i += num[0].length
      return Number(num[0])
    }
    this.skipExpr()
    return undefined
  }

  private key(): string | undefined {
    const ch = this.peek()
    if (ch === '"' || ch === "'") return this.str()
    if (ch === '[') {
      this.skipExpr()
      return undefined
    }
    const m = /^[\w$-]+/.exec(this.src.slice(this.i))
    if (!m) return undefined
    this.i += m[0].length
    return m[0]
  }

  private obj(): { [key: string]: Lit } {
    const out: { [key: string]: Lit } = {}
    this.i++ // {
    while (this.i < this.src.length) {
      if (this.peek() === '}') {
        this.i++
        return out
      }
      if (this.src.startsWith('...', this.i)) {
        this.i += 3
        this.skipExpr()
      } else {
        const k = this.key()
        if (this.peek() === ':') {
          this.i++
          const v = this.value()
          if (k !== undefined && v !== undefined) out[k] = v
        } else if (this.peek() === '(') {
          this.skipExpr() // a method — skipped
        }
      }
      if (this.peek() === ',') this.i++
      else if (this.peek() !== '}') this.skipExpr()
      if (this.i >= this.src.length) break
    }
    return out
  }

  private arr(): Lit[] {
    const out: Lit[] = []
    this.i++ // [
    while (this.i < this.src.length) {
      if (this.peek() === ']') {
        this.i++
        return out
      }
      const v = this.value()
      if (v !== undefined) out.push(v)
      if (this.peek() === ',') this.i++
      else if (this.peek() !== ']') return out
    }
    return out
  }

  /** The object literal right after `theme:` (first occurrence), if any. */
  static themeOf(src: string): { [key: string]: Lit } | undefined {
    const m = /\btheme\s*:\s*\{/.exec(src)
    if (!m) return undefined
    const p = new LiteralParser(src)
    p.i = m.index + m[0].length - 1
    const v = p.value()
    return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined
  }
}

/** Tailwind v3 theme keys → the v4 namespace each lands in. */
const TAILWIND_KEYS: Record<string, TokenType> = {
  colors: 'color',
  spacing: 'spacing',
  borderRadius: 'radius',
  fontFamily: 'fontFamily',
  fontSize: 'fontSize',
  fontWeight: 'fontWeight',
  lineHeight: 'lineHeight',
  letterSpacing: 'letterSpacing',
  opacity: 'opacity',
  screens: 'breakpoint',
  maxWidth: 'container',
}

const tokenSegment = (key: string) => key.replace(/[^a-zA-Z0-9_-]/g, '-')

/** Every literal token a Tailwind config's `theme` (and `theme.extend`) holds. */
export function parseTailwindTokens(source: string, file: string): RepoToken[] {
  const theme = LiteralParser.themeOf(source)
  if (!theme) return []
  const out = new Map<string, RepoToken>()
  const sections = [theme, theme.extend].filter(
    (s): s is { [key: string]: Lit } => !!s && typeof s === 'object' && !Array.isArray(s),
  )
  for (const section of sections)
    for (const [key, type] of Object.entries(TAILWIND_KEYS)) {
      const group = section[key]
      if (!group || typeof group !== 'object' || Array.isArray(group)) continue
      flatten(group, TOKEN_NAMESPACE[type].slice(0, -1), type, file, out)
    }
  return [...out.values()]
}

function flatten(
  group: { [key: string]: Lit },
  stem: string,
  type: TokenType,
  file: string,
  out: Map<string, RepoToken>,
) {
  for (const [key, raw] of Object.entries(group)) {
    const name = key === 'DEFAULT' ? stem : `${stem}-${tokenSegment(key)}`
    let value: string | undefined
    if (typeof raw === 'string' || typeof raw === 'number') value = String(raw)
    else if (Array.isArray(raw)) {
      /* fontFamily: ['Inter', 'sans-serif']; fontSize: ['1rem', { lineHeight }] */
      const strings = raw.filter((v): v is string => typeof v === 'string')
      value =
        type === 'fontFamily'
          ? strings.map((f) => (/\s/.test(f) && !/^["']/.test(f) ? `"${f}"` : f)).join(', ')
          : strings[0]
    } else if (raw && typeof raw === 'object') {
      flatten(raw, name, type, file, out)
      continue
    }
    if (!value || !isTokenName(name)) continue
    out.set(name, { name, type, value, file, line: 0, origin: 'tailwind' })
  }
}

/* ------------------------------------------------------------------ */
/* the diff                                                            */
/* ------------------------------------------------------------------ */

/** One token where the two sides disagree. */
export interface TokenDiffEntry {
  name: string
  type: TokenType
  /** `add`: only the repo has it; `change`: both, values differ; `doop-only`: only the canvas has it */
  kind: 'add' | 'change' | 'doop-only'
  repo?: Pick<RepoToken, 'value' | 'themes' | 'file' | 'line' | 'origin'>
  doop?: Pick<DesignToken, 'value' | 'themes'>
}

export interface TokenDiff {
  entries: TokenDiffEntry[]
  /** tokens equal on both sides */
  same: number
  /** the files the repo side was read from */
  files: string[]
}

const sameValue = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()

function sameThemes(a: Record<string, string> = {}, b: Record<string, string> = {}): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) if (!sameValue(a[k] ?? '', b[k] ?? '')) return false
  return true
}

/** Merge per-file parses: CSS wins over a Tailwind config for the same name
 *  (the CSS is what ships), and a later file over an earlier one. */
export function mergeRepoTokens(lists: readonly RepoToken[][]): Map<string, RepoToken> {
  const out = new Map<string, RepoToken>()
  for (const list of lists)
    for (const t of list) {
      const prev = out.get(t.name)
      if (prev && prev.origin === 'css' && t.origin === 'tailwind') continue
      if (prev && !t.value && prev.value) {
        out.set(t.name, {
          ...prev,
          themes: { ...prev.themes, ...t.themes },
          themeLines: { ...prev.themeLines, ...t.themeLines },
        })
        continue
      }
      out.set(t.name, t)
    }
  return out
}

export function diffTokens(repo: Map<string, RepoToken>, doop: readonly DesignToken[], files: string[]): TokenDiff {
  const entries: TokenDiffEntry[] = []
  let same = 0
  const doopByName = new Map(doop.map((t) => [t.name, t]))
  for (const r of repo.values()) {
    if (!r.value) continue
    const repoSide = { value: r.value, themes: r.themes, file: r.file, line: r.line, origin: r.origin }
    const d = doopByName.get(r.name)
    if (!d) entries.push({ name: r.name, type: r.type, kind: 'add', repo: repoSide })
    else if (sameValue(d.value, r.value) && sameThemes(d.themes, r.themes)) same++
    else
      entries.push({
        name: r.name,
        type: d.type,
        kind: 'change',
        repo: repoSide,
        doop: { value: d.value, themes: d.themes },
      })
  }
  for (const d of doop)
    if (!repo.has(d.name) || !repo.get(d.name)!.value)
      entries.push({ name: d.name, type: d.type, kind: 'doop-only', doop: { value: d.value, themes: d.themes } })
  const order = { change: 0, add: 1, 'doop-only': 2 }
  entries.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name))
  return { entries, same, files }
}
