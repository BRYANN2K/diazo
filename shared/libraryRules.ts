/**
 * A library's import and indexing rules: how frames become items, what id
 * and category each gets, and what quality gate a new item passes. Stored
 * as versioned JSON on the library; every read goes through
 * `parseLibraryRules`, so a stored value from an older build still loads.
 */
import { z } from 'zod'
import { splitFrameName } from './libraryIds.ts'

/** Selectors in rules run over untrusted markup: capped, compiled in a try. */
export const MAX_SELECTOR = 200

const selector = z.string().max(MAX_SELECTOR)
const glob = z.string().min(1).max(MAX_SELECTOR)

const rulesSchema = z.object({
  version: z.literal(1),
  ids: z.object({
    pattern: z.enum(['kind.source-slug', 'kind.slug', 'slug']),
    onCollision: z.enum(['suffix', 'reject', 'replace']),
    /** the kind given to an item whose name has no id; '' gives none */
    defaultKind: z
      .string()
      .max(24)
      .regex(/^[a-z0-9]*$/),
  }),
  naming: z.object({ frameName: z.enum(['{id} — {label}', '{label}']) }),
  detect: z.object({
    /** frame names that are not items: section headers, page titles, indexes */
    ignore: z.array(glob).max(50),
    /** a frame whose name matches starts a category for the frames after it */
    section: glob.nullable(),
    variants: z.object({
      mode: z.enum(['auto', 'selectors', 'none']),
      cell: selector.optional(),
      id: selector.optional(),
      label: selector.optional(),
      /** what is previewed, boxed and copied */
      design: selector.optional(),
    }),
  }),
  categorise: z.object({
    by: z.array(z.enum(['marker', 'section', 'page', 'kind'])).max(4),
    kindMap: z.record(z.string().max(120)),
    fallback: z.string().min(1).max(120),
  }),
  css: z.object({
    inlineSymbols: z.boolean(),
    pruneUnused: z.boolean(),
    freezeScripts: z.enum(['never', 'ask', 'always']),
  }),
  tokens: z.object({ map: z.enum(['off', 'suggest', 'apply']) }),
  lint: z.object({
    gate: z.enum(['off', 'warn', 'draft']),
    minScore: z.number().min(0).max(100),
    ignoreRules: z.array(z.string().max(80)).max(100),
  }),
  dedup: z.object({
    by: z.array(z.enum(['id', 'hash'])).max(2),
    onDuplicate: z.enum(['draft', 'skip', 'replace']),
  }),
  placement: z.object({ page: z.enum(['category', 'current']), gap: z.number().min(0).max(2000) }),
  search: z.object({ synonyms: z.record(z.array(z.string().max(60)).max(20)) }),
})

export type LibraryRules = z.infer<typeof rulesSchema>

const BLANK: LibraryRules = {
  version: 1,
  ids: { pattern: 'slug', onCollision: 'suffix', defaultKind: '' },
  naming: { frameName: '{label}' },
  detect: { ignore: [], section: null, variants: { mode: 'none' } },
  categorise: { by: ['marker', 'page'], kindMap: {}, fallback: 'Unsorted' },
  css: { inlineSymbols: true, pruneUnused: true, freezeScripts: 'never' },
  tokens: { map: 'off' },
  lint: { gate: 'off', minScore: 60, ignoreRules: [] },
  dedup: { by: ['id'], onDuplicate: 'draft' },
  placement: { page: 'current', gap: 80 },
  search: { synonyms: {} },
}

/** Bryan's convention: `{id} — {label}` names, `§` sections, sheets of variants. */
const SHEETS: LibraryRules = {
  version: 1,
  ids: { pattern: 'kind.source-slug', onCollision: 'suffix', defaultKind: '' },
  naming: { frameName: '{id} — {label}' },
  detect: {
    ignore: ['§ *', '* — title', 'INDEX*'],
    section: '§ * — {category}',
    variants: { mode: 'auto' },
  },
  categorise: {
    by: ['marker', 'section', 'page', 'kind'],
    kindMap: {
      cp: 'Components',
      bk: 'Blocks',
      mo: 'Motion',
      hero: 'Heroes',
      footer: 'Footers',
      bg: 'Backgrounds',
      sw: 'Swatches',
      tx: 'Type',
      ft: 'Fonts',
      ic: 'Icons',
      rs: 'Resources',
      as: 'Rules',
    },
    fallback: 'Unsorted',
  },
  css: { inlineSymbols: true, pruneUnused: true, freezeScripts: 'never' },
  tokens: { map: 'off' },
  lint: { gate: 'warn', minScore: 60, ignoreRules: [] },
  dedup: { by: ['id', 'hash'], onDuplicate: 'draft' },
  placement: { page: 'category', gap: 80 },
  search: { synonyms: {} },
}

export type RulePresetName = 'blank' | 'sheets'

export const RULE_PRESETS: Record<RulePresetName, LibraryRules> = { blank: BLANK, sheets: SHEETS }

export const DEFAULT_LIBRARY_RULES: LibraryRules = BLANK

/** Kinds that are references, not designs: never inserted. */
export const NON_INSERTABLE_KINDS = new Set(['rs', 'as'])

export type ParsedRules = { ok: true; rules: LibraryRules } | { ok: false; errors: { path: string; message: string }[] }

/** Read rules strictly: unknown keys are dropped, anything out of range is
 *  an error naming its path (`detect.variants.cell`). */
export function parseLibraryRules(raw: unknown): ParsedRules {
  const parsed = rulesSchema.safeParse(raw)
  if (parsed.success) return { ok: true, rules: parsed.data }
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  }
}

/** Rules as stored, with anything unreadable replaced by the defaults. */
export function rulesOrDefault(raw: unknown): LibraryRules {
  const parsed = parseLibraryRules(raw)
  return parsed.ok ? parsed.rules : DEFAULT_LIBRARY_RULES
}

const globCache = new Map<string, RegExp>()

function globRegExp(pattern: string, capture = false): RegExp {
  const key = `${capture ? 'c' : 'm'}${pattern}`
  let re = globCache.get(key)
  if (!re) {
    const body = pattern
      .split(/(\*|\{category\})/)
      .map((part) =>
        part === '*'
          ? capture
            ? '(.*?)'
            : '.*'
          : part === '{category}'
            ? '(.+)'
            : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'),
      )
      .join('')
    re = new RegExp(`^${body}$`, 'i')
    globCache.set(key, re)
  }
  return re
}

/** Does a frame name match a glob (`§ *`, `* — title`)? `*` is any text. */
export function nameMatches(pattern: string, name: string): boolean {
  return globRegExp(pattern.replace(/\{category\}/g, '*')).test(name.trim())
}

/** The category a section frame starts: `{category}`, under the domain the
 *  pattern's `*` captured, with a trailing sub-letter (`Inputs A`) dropped. */
export function sectionCategory(pattern: string | null, name: string): string | null {
  if (!pattern || !pattern.includes('{category}')) return null
  const m = globRegExp(pattern, true).exec(name.trim())
  if (!m) return null
  const parts = m.slice(1).map((s) => (s ?? '').trim())
  const category = parts.pop() ?? ''
  const domain = parts
    .map((p) => p.replace(/\s+[A-Z]$/, '').trim())
    .filter(Boolean)
    .join('/')
  if (!category) return domain || null
  return domain ? `${domain}/${category}` : category
}

/** Does `rules` say this frame name is not an item? */
export function isIgnoredName(rules: LibraryRules, name: string): boolean {
  return rules.detect.ignore.some((g) => nameMatches(g, name))
}

function explainedBySheets(name: string): boolean {
  return splitFrameName(name).id !== null || isIgnoredName(SHEETS, name)
}

/** The preset that explains more of a canvas's frame names. */
export function detectPreset(frameNames: string[]): RulePresetName {
  if (!frameNames.length) return 'blank'
  const explained = frameNames.filter(explainedBySheets).length
  return explained * 2 > frameNames.length ? 'sheets' : 'blank'
}

/** The rules in plain words, for agents and the settings summary. */
export function describeRules(rules: LibraryRules): string[] {
  const lines: string[] = []
  lines.push(
    rules.naming.frameName === '{id} — {label}'
      ? 'Frames are named "<id> — <label>"; the id comes from the name.'
      : 'Frames are named by their label; ids are assigned on import.',
  )
  lines.push(`New ids follow ${rules.ids.pattern}; on a collision: ${rules.ids.onCollision}.`)
  if (rules.detect.ignore.length) lines.push(`Not items: frames named ${rules.detect.ignore.join(', ')}.`)
  if (rules.detect.section)
    lines.push(`A frame named ${rules.detect.section} starts a category for the frames below it.`)
  const v = rules.detect.variants
  lines.push(
    v.mode === 'none'
      ? 'Each frame is one item; no variants are read.'
      : v.mode === 'auto'
        ? 'Variants are found automatically: repeated cells that each carry one id.'
        : `Variants are the cells matching ${v.cell ?? '(none)'}, their id in ${v.id ?? '(none)'}.`,
  )
  lines.push(
    `Categories come from: ${rules.categorise.by.join(', ') || 'nothing'}; else "${rules.categorise.fallback}".`,
  )
  if (rules.lint.gate !== 'off') {
    lines.push(
      `Quality gate: a lint score under ${rules.lint.minScore} ${rules.lint.gate === 'draft' ? 'keeps the item as a draft' : 'is noted'}.`,
    )
  }
  if (rules.tokens.map !== 'off')
    lines.push(
      `Literal values equal to a token are ${rules.tokens.map === 'apply' ? 'rewritten to var(--token)' : 'listed'}.`,
    )
  const synonyms = Object.keys(rules.search.synonyms)
  if (synonyms.length) lines.push(`Search synonyms for: ${synonyms.join(', ')}.`)
  return lines
}
