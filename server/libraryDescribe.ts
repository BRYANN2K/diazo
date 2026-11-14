/**
 * AI descriptions and tags for thin library items (plan step 8.2, D9).
 *
 * Off by default: a library's managers turn it on in its settings
 * (`libraries.describe_items`). With it off, nothing here calls a model. On,
 * each item whose description or tags a person left empty gets one vision
 * call on its thumbnail, answered as `{ description, tags }`, and the result
 * is kept apart in `library_item_meta.suggested`: searchable at once
 * (effectiveItem folds it into the item's search text), shown in the inbox
 * with Accept, and written as people's words only when accepted. Nothing a
 * person wrote is ever overwritten; a failed call leaves the item as it was.
 *
 * Who pays: the library canvas's owner, resolved like an image description
 * (`describerFor` in server/imageDescriptions.ts: their connected model,
 * else the server's; their Off there stops this too). At most
 * DESCRIBE_PER_DAY calls per library per UTC day.
 */
import type { LibraryItem, LibraryItemMeta } from '../shared/library.ts'
import { store } from './store.ts'
import { allLibraries, getLibrary, onLibraryChange } from './libraries.ts'
import { itemMeta, libraryItems, saveMeta } from './libraryIndex.ts'
import { itemThumb } from './libraryThumbs.ts'
import { describerFor } from './imageDescriptions.ts'

export const DESCRIBE_PER_DAY = 200
const MAX_DESCRIPTION = 400
const MAX_TAGS = 8
const SWEEP_MS = 60 * 60_000

export interface Suggestion {
  description: string
  tags: string[]
}

/** One item described by a model on the payer's account. Null: there is no
 *  model to ask (the run stops); a throw: this item failed (it is skipped). */
export type ItemDescriber = (item: LibraryItem, payerId: string | undefined) => Promise<Suggestion | null>

const PROMPT = `You see one UI design element from a design library (a component, block or screen). Answer with JSON only: {"description": "<one or two plain sentences: what it is and what it is for>", "tags": ["<up to 8 lowercase single words a designer would search for it by>"]}. No preamble.`

const modelDescriber: ItemDescriber = async (item, payerId) => {
  const describer = await describerFor(payerId, payerId)
  if (!describer.model) return null
  const jpeg = await itemThumb(item)
  const result = await describer.model.run({
    system: [{ text: PROMPT }],
    tools: [],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
          { type: 'text', text: `Its name in the library: ${item.label || item.itemId}.` },
        ],
      },
    ],
    maxTokens: 300,
    signal: AbortSignal.timeout(20_000),
  })
  const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
  return parseSuggestion(text)
}

/** The model's answer, or a throw when it is not the JSON asked for. */
export function parseSuggestion(text: string): Suggestion {
  const json = /\{[\s\S]*\}/.exec(text)?.[0]
  if (!json) throw new Error('the model did not answer with JSON')
  const raw = JSON.parse(json) as { description?: unknown; tags?: unknown }
  const description = typeof raw.description === 'string' ? raw.description.trim().slice(0, MAX_DESCRIPTION) : ''
  const tags = Array.isArray(raw.tags)
    ? [
        ...new Set(
          raw.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim().toLowerCase().slice(0, 40)),
        ),
      ]
        .filter(Boolean)
        .slice(0, MAX_TAGS)
    : []
  return { description, tags }
}

let describer: ItemDescriber = modelDescriber
/** Tests swap the model call. */
export function setItemDescriber(fn: ItemDescriber | null): void {
  describer = fn ?? modelDescriber
}

const spent = new Map<string, { day: string; count: number }>()
const running = new Map<string, Promise<number>>()

export function resetDescribeForTest(): void {
  spent.clear()
  running.clear()
}

function today(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

function takeBudget(canvasId: string, now: number): boolean {
  const day = today(now)
  const current = spent.get(canvasId)
  const count = current?.day === day ? current.count : 0
  if (count >= DESCRIBE_PER_DAY) return false
  spent.set(canvasId, { day, count: count + 1 })
  return true
}

/** What a person left empty on this item, that a model may fill. */
function openFields(item: LibraryItem, meta: LibraryItemMeta | undefined): { description: boolean; tags: boolean } {
  if (meta?.suggested) return { description: false, tags: false }
  return {
    description: meta?.description == null && !item.description.trim(),
    tags: meta?.tags == null && item.tags.length === 0,
  }
}

/**
 * One pass over a library: describe what is thin, within the day's budget.
 * Returns how many items got a suggestion. Does nothing while the switch is
 * off.
 */
export async function describeLibrary(canvasId: string, now = Date.now()): Promise<number> {
  const record = getLibrary(canvasId)
  if (!record?.describeItems) return 0
  const payerId = store.getCanvas(canvasId)?.ownerId
  let described = 0
  for (const item of await libraryItems(canvasId)) {
    if (item.status === 'hidden') continue
    const open = openFields(item, await itemMeta(canvasId, item.itemId))
    if (!open.description && !open.tags) continue
    if (!getLibrary(canvasId)?.describeItems) break
    if (!takeBudget(canvasId, now)) break
    let suggestion: Suggestion | null
    try {
      suggestion = await describer(item, payerId)
    } catch (error) {
      console.warn(`[library] could not describe ${item.itemId}:`, error instanceof Error ? error.message : error)
      continue
    }
    if (!suggestion) break
    /* a person may have written while the model was thinking */
    const current = await itemMeta(canvasId, item.itemId)
    const still = openFields(item, current)
    const description = still.description && suggestion.description ? suggestion.description : null
    const tags = still.tags && suggestion.tags.length ? suggestion.tags : null
    if (!description && !tags) continue
    await saveMeta({
      canvasId,
      itemId: item.itemId,
      label: null,
      description: null,
      category: null,
      tags: null,
      status: null,
      useCount: 0,
      lastUsedAt: null,
      updatedBy: null,
      ...current,
      updatedAt: current?.updatedAt ?? now,
      suggested: { description, tags, at: now },
    })
    described++
  }
  return described
}

/** Run a pass unless one is already running on that library. */
export function scheduleDescribe(canvasId: string): Promise<number> {
  const busy = running.get(canvasId)
  if (busy) return busy
  const run = describeLibrary(canvasId)
    .catch((error: unknown) => {
      console.error(`[library] describe pass failed on ${canvasId}:`, error)
      return 0
    })
    .finally(() => running.delete(canvasId))
  running.set(canvasId, run)
  return run
}

/** Accept a suggestion (it becomes the item's description and tags where
 *  still empty) or dismiss it (never suggested again). */
export async function settleSuggestion(
  canvasId: string,
  itemId: string,
  accept: boolean,
  by: string,
): Promise<LibraryItemMeta | null> {
  const current = await itemMeta(canvasId, itemId)
  const s = current?.suggested
  if (!current || !s) return null
  const meta: LibraryItemMeta = {
    ...current,
    ...(accept && s.description && current.description == null ? { description: s.description } : {}),
    ...(accept && s.tags && current.tags == null ? { tags: s.tags } : {}),
    /* kept, emptied: a dismissed item is not asked about again */
    suggested: { description: null, tags: null, at: s.at },
    updatedAt: Date.now(),
    updatedBy: by,
  }
  await saveMeta(meta)
  return meta
}

/** Switching on starts a pass; an hourly sweep picks up new items and the
 *  next day's budget. */
export function wireLibraryDescribe(): () => void {
  const off = onLibraryChange((canvasId, change) => {
    if (change !== 'disabled' && getLibrary(canvasId)?.describeItems) void scheduleDescribe(canvasId)
  })
  const timer = setInterval(() => {
    for (const record of allLibraries()) if (record.describeItems) void scheduleDescribe(record.canvasId)
  }, SWEEP_MS)
  timer.unref()
  return () => {
    off()
    clearInterval(timer)
  }
}
