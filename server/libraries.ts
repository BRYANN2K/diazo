/**
 * Design libraries: a canvas becomes a library when it has a `libraries`
 * row. This module keeps those rows in memory (hydrated at boot, written
 * through to the database), mirrors each one onto `canvas.library`, and is
 * the one access gate for library routes and tools (`libraryRole`).
 * Spec: .workflow/specs/design-libraries.md.
 */
import type { Actor, Canvas } from '../shared/types.ts'
import type {
  LibraryIndexState,
  LibraryInfo,
  LibraryTaxonomy,
  LibraryVisibility,
  ThumbProgress,
} from '../shared/library.ts'
import { EMPTY_TAXONOMY } from '../shared/library.ts'
import {
  detectPreset,
  parseLibraryRules,
  RULE_PRESETS,
  rulesOrDefault,
  type LibraryRules,
  type RulePresetName,
} from '../shared/libraryRules.ts'
import * as persist from './db/persist.ts'
import { store } from './store.ts'
import { canAccessCanvas, canEditCanvas, canManageCanvas } from './access.ts'
import { broadcastLibrary } from './actions.ts'
import { env } from './env.ts'

export interface LibraryRecord {
  canvasId: string
  description: string
  rules: LibraryRules
  taxonomy: LibraryTaxonomy
  visibility: LibraryVisibility
  indexState: LibraryIndexState | null
  rulesVersion: number
  /** set by "stop being a library"; the row is kept 30 days */
  disabledAt: number | null
  /** AI descriptions and tags for thin items (server/libraryDescribe.ts) */
  describeItems?: boolean
  createdAt: number
  updatedAt: number
  updatedBy: string | null
  /** families and variants in the index */
  counts: { items: number; variants: number }
}

/** What a person may do with a library: use it, curate its items, or
 *  change its rules and visibility. */
export type LibraryRole = 'read' | 'curate' | 'manage'

/** How long a disabled library's rules and curation are kept. */
export const DISABLED_KEEP_MS = 30 * 24 * 60 * 60 * 1000

const records = new Map<string, LibraryRecord>()
/** the thumbnail prewarm's progress (server/libraryThumbQueue.ts), in memory only */
const thumbs = new Map<string, ThumbProgress>()

/** Record the thumbnail prewarm's progress; null forgets it. */
export function setThumbProgress(canvasId: string, progress: ThumbProgress | null): void {
  if (progress) thumbs.set(canvasId, progress)
  else thumbs.delete(canvasId)
}

export function infoOf(record: LibraryRecord): LibraryInfo {
  const progress = thumbs.get(record.canvasId)
  return {
    description: record.description,
    visibility: record.visibility,
    items: record.counts.items,
    variants: record.counts.variants,
    index: record.indexState,
    rulesVersion: record.rulesVersion,
    describeItems: !!record.describeItems,
    ...(progress ? { thumbs: { ...progress } } : {}),
  }
}

function mirror(record: LibraryRecord) {
  store.setLibrary(record.canvasId, record.disabledAt == null ? infoOf(record) : null)
}

/** Fill the records from the database at boot (after store.init). */
export async function hydrateLibraries(): Promise<void> {
  records.clear()
  for (const row of await persist.loadLibraries()) {
    if (!store.getCanvas(row.canvasId)) continue
    const record: LibraryRecord = { ...row, rules: rulesOrDefault(row.rules) }
    records.set(row.canvasId, record)
    mirror(record)
  }
}

/** An active library, or undefined (none, or disabled). */
export function getLibrary(canvasId: string): LibraryRecord | undefined {
  const record = records.get(canvasId)
  return record && record.disabledAt == null ? record : undefined
}

/** Every active library. */
export function allLibraries(): LibraryRecord[] {
  return [...records.values()].filter((r) => r.disabledAt == null)
}

export function libraryInfo(canvas: Canvas): LibraryInfo | null {
  const record = getLibrary(canvas.id)
  return record ? infoOf(record) : null
}

function save(record: LibraryRecord) {
  void persist.saveLibrary(record)
  mirror(record)
}

function announce(record: LibraryRecord, actor: Actor) {
  broadcastLibrary(record.canvasId, record.disabledAt == null ? infoOf(record) : null, actor)
}

/** Listeners told when a library starts or stops (the indexer). */
type LibraryListener = (canvasId: string, change: 'created' | 'updated' | 'disabled', rulesChanged: boolean) => void
const listeners: LibraryListener[] = []
export function onLibraryChange(listener: LibraryListener): () => void {
  listeners.push(listener)
  return () => {
    const at = listeners.indexOf(listener)
    if (at >= 0) listeners.splice(at, 1)
  }
}
const notify: LibraryListener = (canvasId, change, rulesChanged) => {
  for (const l of listeners) l(canvasId, change, rulesChanged)
}

/** The preset that explains more of the canvas's frame names. */
export function presetFor(canvas: Canvas): RulePresetName {
  return detectPreset(canvas.frames.map((f) => f.name))
}

/**
 * Turn a canvas into a library. A library disabled less than 30 days ago
 * comes back with its rules (curation was never deleted). Writes no frame.
 */
export function createLibrary(
  canvasId: string,
  opts: { preset?: RulePresetName; rules?: LibraryRules; taxonomy?: LibraryTaxonomy; description?: string },
  actor: Actor,
  now = Date.now(),
): LibraryRecord | undefined {
  const canvas = store.getCanvas(canvasId)
  if (!canvas) return undefined
  const existing = records.get(canvasId)
  if (existing && existing.disabledAt == null) return existing
  const restoring = existing && now - (existing.disabledAt ?? 0) < DISABLED_KEEP_MS ? existing : undefined
  const preset = opts.preset ?? presetFor(canvas)
  const record: LibraryRecord = {
    canvasId,
    description: opts.description ?? restoring?.description ?? '',
    rules: opts.rules ?? restoring?.rules ?? RULE_PRESETS[preset],
    taxonomy: opts.taxonomy ?? restoring?.taxonomy ?? EMPTY_TAXONOMY,
    visibility: restoring?.visibility ?? 'private',
    indexState: null,
    rulesVersion: (restoring?.rulesVersion ?? 0) + 1,
    disabledAt: null,
    createdAt: restoring?.createdAt ?? now,
    updatedAt: now,
    updatedBy: actor.name,
    counts: { items: 0, variants: 0 },
  }
  records.set(canvasId, record)
  save(record)
  announce(record, actor)
  notify(canvasId, 'created', true)
  return record
}

export interface LibraryPatch {
  description?: string
  rules?: unknown
  taxonomy?: LibraryTaxonomy
  visibility?: LibraryVisibility
  describeItems?: boolean
}

export type PatchResult =
  { ok: true; record: LibraryRecord } | { ok: false; status: 400 | 404; errors: { path: string; message: string }[] }

/** Change a library's description, rules, taxonomy or visibility. New rules
 *  bump `rulesVersion`, so items indexed under the old ones are stale. */
export function updateLibrary(canvasId: string, patch: LibraryPatch, actor: Actor, now = Date.now()): PatchResult {
  const record = getLibrary(canvasId)
  if (!record) return { ok: false, status: 404, errors: [] }
  let rules: LibraryRules | undefined
  if (patch.rules !== undefined) {
    const parsed = parseLibraryRules(patch.rules)
    if (!parsed.ok) return { ok: false, status: 400, errors: parsed.errors }
    rules = parsed.rules
  }
  if (patch.visibility === 'workspace' && !store.getCanvas(canvasId)?.workspaceId) {
    return {
      ok: false,
      status: 400,
      errors: [{ path: 'visibility', message: 'only a canvas in a workspace can be a workspace library' }],
    }
  }
  if (patch.visibility === 'public' && !env.DOOP_PUBLIC_LIBRARIES) {
    return {
      ok: false,
      status: 400,
      errors: [{ path: 'visibility', message: 'public libraries are off on this instance (DOOP_PUBLIC_LIBRARIES)' }],
    }
  }
  const rulesChanged = !!rules && JSON.stringify(rules) !== JSON.stringify(record.rules)
  if (patch.description !== undefined) record.description = patch.description.slice(0, 2000)
  if (patch.taxonomy) record.taxonomy = patch.taxonomy
  if (patch.visibility) record.visibility = patch.visibility
  if (patch.describeItems !== undefined) record.describeItems = patch.describeItems
  if (rules && rulesChanged) {
    record.rules = rules
    record.rulesVersion++
  }
  record.updatedAt = now
  record.updatedBy = actor.name
  save(record)
  announce(record, actor)
  notify(canvasId, 'updated', rulesChanged)
  return { ok: true, record }
}

/** "Stop being a library": the index goes, the rules and curation stay
 *  (restored by a new conversion within 30 days). */
export function disableLibrary(canvasId: string, actor: Actor, now = Date.now()): boolean {
  const record = getLibrary(canvasId)
  if (!record) return false
  record.disabledAt = now
  record.updatedAt = now
  record.updatedBy = actor.name
  record.indexState = null
  record.counts = { items: 0, variants: 0 }
  save(record)
  announce(record, actor)
  notify(canvasId, 'disabled', false)
  return true
}

/** Record index progress and counts (the indexer). Not broadcast per call. */
export function setIndexState(
  canvasId: string,
  state: LibraryIndexState | null,
  counts?: { items: number; variants: number },
): void {
  const record = getLibrary(canvasId)
  if (!record) return
  record.indexState = state
  if (counts) record.counts = counts
  save(record)
}

/** Tell the canvas's room that the library's state changed (end of an index run). */
export function announceLibrary(canvasId: string, actor: Actor): void {
  const record = getLibrary(canvasId)
  if (record) announce(record, actor)
}

/** Copy a library's row and curation onto a duplicated canvas. */
export async function copyLibrary(fromCanvasId: string, toCanvasId: string, now = Date.now()): Promise<void> {
  const source = getLibrary(fromCanvasId)
  if (!source || !store.getCanvas(toCanvasId)) return
  const record: LibraryRecord = {
    ...structuredClone(source),
    canvasId: toCanvasId,
    visibility: 'private',
    indexState: null,
    counts: { items: 0, variants: 0 },
    createdAt: now,
    updatedAt: now,
  }
  records.set(toCanvasId, record)
  save(record)
  await persist.copyItemMeta(fromCanvasId, toCanvasId)
  notify(toCanvasId, 'created', true)
}

/** Forget a deleted canvas's library (the rows go with persist.deleteCanvas). */
export function forgetLibrary(canvasId: string): void {
  records.delete(canvasId)
}

/** Follow canvas copies and deletions (once, at boot). */
export function wireLibraries(): () => void {
  return store.onCanvasEvent((event) => {
    if (event.kind === 'deleted') forgetLibrary(event.canvasId)
    else
      copyLibrary(event.from, event.to).catch((error: unknown) =>
        console.error('[libraries] copying a library failed', event.to, error),
      )
  })
}

/** The one gate: what this user may do with this canvas as a library, or
 *  null (no access, or not a library). A library read is not canvas access:
 *  it opens the library routes and tools only. */
export function libraryRole(userId: string | undefined, canvas: Canvas | undefined): LibraryRole | null {
  const record = canvas && getLibrary(canvas.id)
  if (!canvas || !record) return null
  if (canManageCanvas(userId, canvas)) return 'manage'
  if (canEditCanvas(userId, canvas)) return 'curate'
  if (canAccessCanvas(userId, canvas)) return 'read'
  /* the flag is read on every call: turning it off hides public libraries at once */
  if (record.visibility === 'public' && env.DOOP_PUBLIC_LIBRARIES && userId) return 'read'
  return null
}

const RANK: Record<LibraryRole, number> = { read: 0, curate: 1, manage: 2 }

export function libraryAllows(role: LibraryRole | null, need: LibraryRole): boolean {
  return !!role && RANK[role] >= RANK[need]
}

/** Delete the libraries disabled more than 30 days ago: their row, items
 *  and curation (the boot job). Returns the canvases purged. */
export async function purgeDisabledLibraries(now = Date.now()): Promise<string[]> {
  const purged: string[] = []
  for (const record of [...records.values()]) {
    if (record.disabledAt == null || now - record.disabledAt < DISABLED_KEEP_MS) continue
    records.delete(record.canvasId)
    await persist.deleteLibrary(record.canvasId)
    purged.push(record.canvasId)
  }
  return purged
}

/** For tests: drop every record. */
export function resetLibrariesForTest(): void {
  records.clear()
}

/** For tests and the boot purge: every record, disabled ones included. */
export function allRecords(): LibraryRecord[] {
  return [...records.values()]
}
