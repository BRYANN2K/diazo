/**
 * "We already have it": before anything enters a library, look for the
 * same page, the same design or a near copy in every library the person
 * can use (not only the target). Read from the index rows, never from
 * frame HTML, so a check across 10,000 items stays cheap.
 *
 * - same-url: the item was captured from the same page (normalised URL);
 * - same-content: it was copied from the same frame (`data-doop-origin`),
 *   or its content hash equals the candidate's under that library's rules;
 * - similar: its name and text share at least SIMILAR_AT of their words.
 */
import type { Canvas } from '../shared/types.ts'
import type { LibraryItem } from '../shared/library.ts'
import {
  SIMILAR_AT,
  normalizeSourceUrl,
  originOf,
  similarity,
  sourceKeyOf,
  wordsOf,
  type DuplicateMatch,
} from '../shared/libraryProvenance.ts'
import { getLibrary } from './libraries.ts'
import { libraryItems } from './libraryIndex.ts'
import { extractFrameItems } from './libraryExtract.ts'
import { itemUrl } from './libraryQueries.ts'

/** What is about to enter a library: a frame (its HTML and where it is),
 *  or only a URL and words (an agent asking "do we have X?"). */
export interface DuplicateCandidate {
  name: string
  html?: string
  /** the frame being imported, `<canvasId>:<frameId>` */
  ref?: string
  url?: string
  text?: string
}

/** At most this many matches per candidate, best first. */
const MAX_MATCHES = 5

const REASON_RANK = { 'same-url': 0, 'same-content': 1, similar: 2 } as const

/** The family hash a library's indexer would give this HTML. */
function hashUnder(canvas: Canvas, candidate: DuplicateCandidate): string | null {
  if (!candidate.html) return null
  const record = getLibrary(canvas.id)
  if (!record) return null
  try {
    const out = extractFrameItems({
      frame: { id: 'candidate', name: candidate.name, html: candidate.html },
      pageName: '',
      sectionCategory: null,
      rules: record.rules,
      taxonomy: record.taxonomy,
    })
    return out.items.find((i) => !i.parentId)?.hash ?? null
  } catch {
    return null
  }
}

function visible(html: string): string {
  return html
    .replace(/<(script|style|svg|template|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The items of `libraries` each candidate would duplicate. `exact` leaves
 * near copies out (the curation, which folds its own near copies). Items
 * of the very frame being imported (a frame already in the library) are
 * not matches.
 */
export async function findDuplicates(
  candidates: DuplicateCandidate[],
  libraries: Canvas[],
  opts: { exact?: boolean } = {},
): Promise<DuplicateMatch[][]> {
  const prepared = candidates.map((c) => {
    const html = c.html ?? ''
    const ownOrigin = (html && originOf(html)) || c.ref || null
    return {
      candidate: c,
      url: normalizeSourceUrl(c.url) ?? (html ? sourceKeyOf(html) : null),
      origins: new Set([ownOrigin, c.ref].filter((o): o is string => !!o)),
      words: wordsOf(c.name, c.text ?? (html ? visible(html) : '')),
    }
  })
  const out: DuplicateMatch[][] = candidates.map(() => [])
  for (const canvas of libraries) {
    if (!getLibrary(canvas.id)) continue
    const items = (await libraryItems(canvas.id)).filter((i) => !i.parentId && i.status !== 'hidden')
    const hashes = prepared.map((p) => hashUnder(canvas, p.candidate))
    prepared.forEach((p, at) => {
      const ref = p.candidate.ref
      for (const item of items) {
        if (ref && `${canvas.id}:${item.frameId}` === ref) continue
        const reason = reasonOf(item, p, hashes[at] ?? null, !!opts.exact)
        if (!reason) continue
        out[at]!.push({
          libraryId: canvas.id,
          libraryName: canvas.name,
          itemId: item.itemId,
          name: item.label,
          category: item.category,
          reason: reason.reason,
          score: Math.round(reason.score * 100) / 100,
          url: itemUrl(canvas.id, item.itemId),
        })
      }
    })
  }
  return out.map((list) =>
    list.sort((a, b) => REASON_RANK[a.reason] - REASON_RANK[b.reason] || b.score - a.score).slice(0, MAX_MATCHES),
  )
}

function reasonOf(
  item: LibraryItem,
  p: { url: string | null; origins: Set<string>; words: Set<string> },
  hash: string | null,
  exact: boolean,
): { reason: DuplicateMatch['reason']; score: number } | null {
  if (p.url && item.sourceKey && item.sourceKey === p.url) return { reason: 'same-url', score: 1 }
  if (item.origin && p.origins.has(item.origin)) return { reason: 'same-content', score: 1 }
  if (hash && item.hash === hash) return { reason: 'same-content', score: 1 }
  if (exact) return null
  const score = similarity(p.words, wordsOf(item.label, item.searchText))
  return score >= SIMILAR_AT ? { reason: 'similar', score } : null
}

/** One line per match, for an agent to tell the human. */
export function describeMatches(matches: DuplicateMatch[]): string {
  return matches
    .map(
      (m) =>
        `already in "${m.libraryName}" → ${m.category}: ${m.name} (${m.itemId}, ${m.reason}${m.reason === 'similar' ? ` ${Math.round(m.score * 100)}%` : ''})`,
    )
    .join('; ')
}
