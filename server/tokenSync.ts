import { linkFor, localRepo, repoToolCall } from './localRepo.ts'
import { store } from './store.ts'
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
    throw new TokenSyncError("the linked project is unavailable — the doop desktop app holding it isn't online", 409)
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
