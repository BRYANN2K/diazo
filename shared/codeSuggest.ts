/**
 * Where a component or frame probably lives in the linked repo, ranked from
 * two bounded reads of the linked project: one `repo_search` for export
 * declarations named after the target, one `repo_list` for files named after
 * it. Pure — the server runs the reads and hands the results in.
 */
import type { RepoSearchMatch, RepoTreeEntry } from './localRepo.ts'

export const CODE_SUGGEST_LIMIT = 5

/** Files a component or a page can live in. */
export const CODE_EXTENSIONS = ['.tsx', '.jsx', '.ts', '.js', '.astro', '.vue', '.svelte', '.mdx'] as const
/** Single-file components export themselves as their default. */
const SFC_EXTENSIONS = new Set(['.astro', '.vue', '.svelte', '.mdx'])

export interface CodeSuggestion {
  path: string
  /** the export to map; null when only the file name matched a script module */
  exportName: string | null
  /** 0-1, higher is likelier */
  score: number
  /** why: the export is declared there, the file is named alike, or both */
  reason: 'export+file' | 'export' | 'file'
  /** the declaration's line, when an export matched */
  line?: number
}

function words(name: string): string[] {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
}

const pascal = (parts: string[]) =>
  parts
    .map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
    .join('')
    .replace(/^\d+/, '')

/** The base of a design name: "Pricing — Desktop (v2)" → "Pricing". */
function baseName(name: string): string {
  return name
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .split(/\s+[—–|/:]\s+|\s+-\s+/)[0]!
    .trim()
}

/**
 * Identifier candidates for a target, most specific first: the full name and
 * its base, PascalCased; frames also try the Page / Screen suffixes routes
 * and screens carry. At most six, each a valid identifier.
 */
export function codeNameCandidates(name: string, kind: 'component' | 'frame'): string[] {
  const out: string[] = []
  const add = (id: string) => {
    if (id && /^[A-Za-z_$][\w$]*$/.test(id) && id.length <= 80 && !out.includes(id)) out.push(id)
  }
  const full = pascal(words(name))
  const base = pascal(words(baseName(name)))
  add(full)
  add(base)
  if (kind === 'frame')
    for (const stem of [base, full]) {
      if (!/(Page|Screen|View)$/.test(stem)) {
        add(`${stem}Page`)
        add(`${stem}Screen`)
      }
    }
  return out.slice(0, 6)
}

/** The Rust-regex `repo_search` runs to find declarations of those names. */
export function exportSearchPattern(candidates: string[]): string {
  return `export\\s+(default\\s+)?(async\\s+)?(function|const|class|let|var)\\s+(${candidates.join('|')})\\b`
}

function splitExt(path: string): { stem: string; ext: string; dir: string } {
  const slash = path.lastIndexOf('/')
  const file = path.slice(slash + 1)
  const dir = slash >= 0 ? path.slice(0, slash) : ''
  const ext = CODE_EXTENSIONS.find((e) => file.toLowerCase().endsWith(e)) ?? ''
  return { stem: ext ? file.slice(0, -ext.length) : file, ext, dir }
}

/** test, story and declaration files are rarely the thing to map */
const secondary = (path: string) =>
  /\.(test|spec|stories|story|d)\.[a-z]+$/i.test(path) || /(^|\/)__tests__\//.test(path)

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Whether a file is named after one of the candidates: `Button.tsx`,
 *  `pricing-card.astro`, or `PricingCard/index.tsx`. */
function fileMatches(path: string, wanted: Set<string>): boolean {
  const { stem, ext, dir } = splitExt(path)
  if (!ext) return false
  if (wanted.has(norm(stem))) return true
  if (stem.toLowerCase() === 'index') return wanted.has(norm(dir.slice(dir.lastIndexOf('/') + 1)))
  return false
}

/**
 * Rank the reads into at most CODE_SUGGEST_LIMIT suggestions, one per file:
 * a file that both declares the export and carries the name scores highest,
 * then a declaration anywhere, then a file named alike. Test and story files
 * sink below everything else.
 */
export function rankCodeSuggestions(
  candidates: string[],
  matches: readonly RepoSearchMatch[],
  entries: readonly RepoTreeEntry[],
): CodeSuggestion[] {
  const wanted = new Set(candidates.map(norm))
  const order = new Map(candidates.map((c, i) => [c, i]))
  const byPath = new Map<string, CodeSuggestion>()
  const keep = (s: CodeSuggestion) => {
    if (secondary(s.path)) s.score = Math.round(s.score * 50) / 100
    const prev = byPath.get(s.path)
    if (!prev || s.score > prev.score) byPath.set(s.path, s)
  }
  const declared = new RegExp(exportSearchPattern(candidates.map((c) => c.replace(/\$/g, '\\$'))))
  for (const m of matches) {
    const found = declared.exec(m.text)
    const name = found?.[4]
    if (!name || !splitExt(m.path).ext) continue
    /* a nearer candidate (the full name before a Page suffix) scores higher */
    const nearness = (order.get(name) ?? 5) * 0.02
    const named = fileMatches(m.path, wanted)
    keep({
      path: m.path,
      exportName: found[1] ? 'default' : name,
      score: (named ? 1 : 0.8) - nearness,
      reason: named ? 'export+file' : 'export',
      line: m.line,
    })
  }
  for (const e of entries) {
    if (e.kind !== 'file' || byPath.has(e.path) || !fileMatches(e.path, wanted)) continue
    keep({
      path: e.path,
      exportName: SFC_EXTENSIONS.has(splitExt(e.path).ext) ? 'default' : null,
      score: 0.6,
      reason: 'file',
    })
  }
  return [...byPath.values()]
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, CODE_SUGGEST_LIMIT)
}
