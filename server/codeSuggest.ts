import { linkFor, localRepo, repoToolCall } from './localRepo.ts'
import { CodeLinkError, resolveCodeTarget } from './codeLinks.ts'
import {
  codeNameCandidates,
  exportSearchPattern,
  rankCodeSuggestions,
  type CodeSuggestion,
} from '../shared/codeSuggest.ts'
import {
  REPO_MAX_DEPTH,
  REPO_MAX_SEARCH_MATCHES,
  type RepoListResult,
  type RepoSearchResult,
} from '../shared/localRepo.ts'
import type { CodeLinkKind } from '../shared/codeLinks.ts'

/* Suggestions for the component ↔ file mapping: two bounded reads of the
 * requester's own linked project — one export search, one tree listing —
 * ranked in shared/codeSuggest.ts. Read-only; nothing is stored until the
 * person (or agent) picks one. */

export interface CodeSuggestReport {
  target: { kind: CodeLinkKind; id: string; name: string }
  /** the identifiers searched for */
  candidates: string[]
  suggestions: CodeSuggestion[]
  /** the linked folder's display name */
  repo: string
  /** a read came back cut short — a bigger repo may hide a better match */
  truncated: boolean
}

export async function suggestCodeLinks(
  userId: string,
  canvasId: string,
  ref: { component?: unknown; frame_id?: unknown },
): Promise<CodeSuggestReport> {
  const target = resolveCodeTarget(canvasId, ref)
  const link = await linkFor(userId, canvasId)
  if (!link) throw new CodeLinkError('no linked project — link this canvas to a folder in the desktop app first', 409)
  const device = localRepo.deviceFor(userId)
  if (!device || !device.grants.has(link.id))
    throw new CodeLinkError("the linked project is unavailable — the doop desktop app holding it isn't online", 409)
  const candidates = codeNameCandidates(target.name, target.kind)
  if (!candidates.length) return { target, candidates, suggestions: [], repo: link.name, truncated: false }
  /* the device answers one request per poll, so the two reads go in turn */
  const search = await repoToolCall(userId, link, 'search', {
    query: exportSearchPattern(candidates),
    regex: true,
    limit: REPO_MAX_SEARCH_MATCHES,
  })
  if (!search.ok) throw new CodeLinkError(search.error ?? 'the repo search failed', 502)
  const list = await repoToolCall(userId, link, 'list', { depth: REPO_MAX_DEPTH })
  if (!list.ok) throw new CodeLinkError(list.error ?? 'the repo listing failed', 502)
  const matches = (search.result as RepoSearchResult | undefined)?.matches ?? []
  const listed = list.result as RepoListResult | undefined
  return {
    target,
    candidates,
    suggestions: rankCodeSuggestions(candidates, matches, listed?.entries ?? []),
    repo: link.name,
    truncated: !!(search.result as RepoSearchResult | undefined)?.truncated || !!listed?.truncated,
  }
}
