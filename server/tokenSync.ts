import { linkFor, localRepo, repoToolCall } from './localRepo.ts'
import { store } from './store.ts'
import * as actions from './actions.ts'
import type { DesignToken, TokenEdit, TokenResult, TokenType } from '../shared/designTokens.ts'
import { diffFromEdits, type LineEdit } from '../shared/patch.ts'
import type { Actor } from '../shared/types.ts'
import type { RepoLink, RepoListResult, RepoReadResult } from '../shared/localRepo.ts'
import { REPO_MAX_DEPTH } from '../shared/localRepo.ts'
import {
  TAILWIND_CONFIG,
  TOKEN_CSS_GLOB,
  TOKEN_SYNC_MAX_FILES,
  diffTokens,
  mergeRepoTokens,
  parseCssTokens,
  parseTailwindTokens,
  type RepoToken,
  type TokenDiff,
} from '../shared/tokenSync.ts'

/* Two-way token sync (shared/tokenSync.ts). The repo side is read through
 * the requester's own linked project — one listing, one bounded read — and
 * parsed, never evaluated. Nothing here writes: applying in doop goes
 * through the ordinary token actions, and the doop → repo direction comes
 * back as a patch only the desktop app's repo_apply_patch can land. */

export class TokenSyncError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

/** Build output and vendored copies hold tokens nobody edits. */
const SKIP_PATH = /(^|\/)(dist|build|out|coverage|\.next|\.nuxt|\.astro|\.svelte-kit|vendor|public)\//

/** Style files likely to declare the design tokens, best first. */
const LIKELY = /(^|[-_.])(tokens?|themes?|variables?|vars|globals?|app|index|main|base|styles?|root)\./i

/** The files one sync reads: Tailwind configs first, then likely style sheets. */
export function pickTokenFiles(paths: readonly string[]): string[] {
  const usable = paths.filter((p) => !SKIP_PATH.test(p))
  const configs = usable.filter((p) => TAILWIND_CONFIG.test(p))
  const css = usable
    .filter((p) => TOKEN_CSS_GLOB.test(p))
    .sort((a, b) => {
      const la = LIKELY.test(a.split('/').pop()!) ? 0 : 1
      const lb = LIKELY.test(b.split('/').pop()!) ? 0 : 1
      return la - lb || a.split('/').length - b.split('/').length || a.localeCompare(b)
    })
  return [...configs.slice(0, 2), ...css].slice(0, TOKEN_SYNC_MAX_FILES)
}

/** What a sync read found: the tokens, and every source file's text (the
 *  patch is built against exactly these bytes). */
export interface RepoTokenRead {
  repo: string
  tokens: Map<string, RepoToken>
  sources: Map<string, string>
  files: string[]
  truncated: boolean
}

async function linkedRepo(userId: string, canvasId: string): Promise<RepoLink> {
  const link = await linkFor(userId, canvasId)
  if (!link) throw new TokenSyncError('no linked project — link this canvas to a folder in the desktop app first', 409)
  const device = localRepo.deviceFor(userId)
  if (!device || !device.grants.has(link.id))
    throw new TokenSyncError("the linked project is unavailable — the Diazo desktop app holding it isn't online", 409)
  return link
}

export async function readRepoTokens(userId: string, canvasId: string): Promise<RepoTokenRead> {
  const link = await linkedRepo(userId, canvasId)
  const list = await repoToolCall(userId, link, 'list', { depth: REPO_MAX_DEPTH })
  if (!list.ok) throw new TokenSyncError(list.error ?? 'the repo listing failed', 502)
  const listed = list.result as RepoListResult
  const picked = pickTokenFiles(listed.entries.filter((e) => e.kind === 'file').map((e) => e.path))
  const sources = new Map<string, string>()
  const parsed: RepoToken[][] = []
  let truncated = listed.truncated
  if (picked.length) {
    const read = await repoToolCall(userId, link, 'read', { paths: picked })
    if (!read.ok) throw new TokenSyncError(read.error ?? 'the repo read failed', 502)
    const result = read.result as RepoReadResult
    truncated ||= result.truncated
    /* Tailwind configs first, so the CSS that ships wins a shared name */
    for (const file of result.files) {
      if (typeof file.text !== 'string') continue
      const tokens = TAILWIND_CONFIG.test(file.path)
        ? parseTailwindTokens(file.text, file.path)
        : parseCssTokens(file.text, file.path)
      if (!tokens.length) continue
      sources.set(file.path, file.text)
      parsed.push(tokens)
    }
  }
  return { repo: link.name, tokens: mergeRepoTokens(parsed), sources, files: [...sources.keys()], truncated }
}

export interface TokenSyncPreview extends TokenDiff {
  repo: string
  truncated: boolean
}

export async function previewTokenSync(userId: string, canvasId: string): Promise<TokenSyncPreview> {
  const read = await readRepoTokens(userId, canvasId)
  return {
    ...diffTokens(read.tokens, store.getTokens(canvasId), read.files),
    repo: read.repo,
    truncated: read.truncated,
  }
}

/* ------------------------------------------------------------------ */
/* doop → repo                                                         */
/* ------------------------------------------------------------------ */

export interface TokenPatchPlan {
  patch: string
  /** names written into the patch */
  names: string[]
  /** names left out, with the reason (a Tailwind config, no style file) */
  skipped: { name: string; reason: string }[]
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The declaration line with `name`'s value swapped; null when the line
 *  no longer carries it. */
function replaceDeclaration(line: string, name: string, value: string): string | null {
  const re = new RegExp(`(${escapeRe(name)}\\s*:\\s*)([^;}]*?)(\\s*(?:;|}|$))`)
  if (!re.test(line)) return null
  return line.replace(re, (_m, head: string, _old: string, tail: string) => `${head}${value}${tail}`)
}

/** The 0-based line of the `}` closing the first `:root` / `@theme` block. */
function rootBlockEnd(text: string): { close: number; indent: string } | null {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*(:root|@theme)\b[^{]*\{/.test(lines[i]!)) continue
    let depth = 0
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]!) {
        if (ch === '{') depth++
        else if (ch === '}') depth--
      }
      if (depth <= 0) {
        if (j === i) return null // a one-line block: no line to insert before
        const inner = lines.slice(i + 1, j).find((l) => /^\s*--/.test(l))
        return { close: j, indent: inner ? /^\s*/.exec(inner)![0] : '  ' }
      }
    }
  }
  return null
}

/**
 * The patch that writes the canvas's values for `names` into the repo's
 * style files: a changed token edits its declaration line in place (its
 * theme lines too), a doop-only one is added to the first `:root` /
 * `@theme` block of the file holding most tokens. Tokens a Tailwind config
 * declares are skipped — editing JS config is left to a person.
 */
export function planTokenPatch(
  read: RepoTokenRead,
  doop: readonly DesignToken[],
  names: readonly string[],
): TokenPatchPlan {
  const byName = new Map(doop.map((t) => [t.name, t]))
  const edits = new Map<string, LineEdit[]>()
  const lineCache = new Map<string, string[]>()
  const linesOf = (file: string) => {
    if (!lineCache.has(file)) lineCache.set(file, read.sources.get(file)!.split('\n'))
    return lineCache.get(file)!
  }
  const written: string[] = []
  const skipped: { name: string; reason: string }[] = []
  const pendingAdds: DesignToken[] = []
  const editLine = (file: string, line: number, name: string, value: string): boolean => {
    const lines = linesOf(file)
    const next = replaceDeclaration(lines[line - 1] ?? '', name, value)
    if (next === null) return false
    const list = edits.get(file) ?? []
    const existing = list.find((e) => e.start === line - 1)
    if (existing) existing.lines = [replaceDeclaration(existing.lines[0]!, name, value) ?? existing.lines[0]!]
    else list.push({ start: line - 1, end: line, lines: [next] })
    edits.set(file, list)
    return true
  }
  for (const name of new Set(names)) {
    const token = byName.get(name)
    if (!token) {
      skipped.push({ name, reason: 'not a token on this canvas' })
      continue
    }
    const repo = read.tokens.get(name)
    if (!repo || !repo.value) {
      pendingAdds.push(token)
      continue
    }
    if (repo.origin === 'tailwind') {
      skipped.push({ name, reason: `declared in ${repo.file} — edit the Tailwind config by hand` })
      continue
    }
    let ok = token.value === repo.value || editLine(repo.file, repo.line, name, token.value)
    for (const [theme, line] of Object.entries(repo.themeLines ?? {})) {
      const value = token.themes?.[theme]
      if (value && value !== repo.themes?.[theme]) ok = editLine(repo.file, line, name, value) && ok
    }
    if (ok) written.push(name)
    else skipped.push({ name, reason: `${repo.file}:${repo.line} no longer declares it — sync again` })
  }
  if (pendingAdds.length) {
    const counts = new Map<string, number>()
    for (const t of read.tokens.values()) if (t.origin === 'css') counts.set(t.file, (counts.get(t.file) ?? 0) + 1)
    const primary = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    const end = primary ? rootBlockEnd(read.sources.get(primary)!) : null
    if (!primary || !end) {
      for (const t of pendingAdds)
        skipped.push({ name: t.name, reason: 'no :root or @theme block in the repo to add it to' })
    } else {
      const list = edits.get(primary) ?? []
      list.push({
        start: end.close,
        end: end.close,
        lines: pendingAdds.map((t) => `${end.indent}${t.name}: ${t.value};`),
      })
      edits.set(primary, list)
      written.push(...pendingAdds.map((t) => t.name))
    }
  }
  const patch = [...edits.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([file, list]) => diffFromEdits(file, read.sources.get(file)!, list))
    .join('')
  return { patch, names: written, skipped }
}

/* ------------------------------------------------------------------ */
/* repo → doop, after approval                                         */
/* ------------------------------------------------------------------ */

export interface ApprovedToken {
  name: string
  type: TokenType
  value: string
  themes?: Record<string, string>
}

/**
 * Take the approved repo values into the canvas: an existing token is
 * edited, a new one created, through the ordinary token actions — so every
 * frame that names a token re-renders, and each change is attributed.
 */
export function applyRepoTokens(canvasId: string, approved: readonly ApprovedToken[], actor: Actor): TokenResult[] {
  const existing = new Set(store.getTokens(canvasId).map((t) => t.name))
  const edits: TokenEdit[] = []
  const creates: ApprovedToken[] = []
  for (const token of approved) {
    if (existing.has(token.name))
      edits.push({ name: token.name, value: token.value, ...(token.themes ? { themes: token.themes } : {}) })
    else creates.push(token)
  }
  const results: TokenResult[] = []
  if (edits.length) results.push(...(actions.setTokens(canvasId, edits, actor) ?? []))
  if (creates.length) results.push(...(actions.createTokens(canvasId, creates, actor) ?? []))
  return results
}

/** The doop → repo patch for `names`, built against a fresh read of the repo. */
export async function previewTokenPatch(userId: string, canvasId: string, names: readonly string[]) {
  const read = await readRepoTokens(userId, canvasId)
  return { ...planTokenPatch(read, store.getTokens(canvasId), names), repo: read.repo }
}
