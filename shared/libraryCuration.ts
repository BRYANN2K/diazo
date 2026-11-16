/**
 * Library curation: an AI builds one clean library out of several source
 * canvases. The sources are read, duplicates folded, a model proposes a
 * category tree from the items themselves and files every item in it; a
 * person reviews and edits the tree; applying writes a NEW canvas whose
 * pages are the categories, then turns it into a library. Nothing is
 * written before apply, and the sources are never written at all.
 *
 * This module is the vocabulary shared by the server (the job, the routes)
 * and the review screen, and the pure parts: reading the model's answers
 * strictly, editing a plan, and summarising it for review.
 * Spec: .workflow/specs/design-libraries.md, "AI curation".
 */
import type { TokenUsage } from './usage.ts'
import { tidyCategoryPart } from './libraryRules.ts'
import type { DuplicateMatch } from './libraryProvenance.ts'

/** At most this many levels in the tree (the library's category depth). */
export const MAX_CURATION_DEPTH = 3
/** Categories with items become pages; a canvas holds 100 before it is a library. */
export const MAX_CURATION_PAGES = 90
/** Source canvases one curation reads. */
export const MAX_CURATION_SOURCES = 8
/** Items (after grouping) one curation handles. */
export const MAX_CURATION_ENTRIES = 20_000
const MAX_NAME = 48

export type CurationStatus =
  'gathering' | 'proposing' | 'classifying' | 'ready' | 'applying' | 'applied' | 'failed' | 'cancelled'

/** The statuses a job is still working in (resumed after a restart). */
export const CURATION_WORKING: ReadonlySet<CurationStatus> = new Set(['gathering', 'proposing', 'classifying'])

export interface FrameRef {
  canvasId: string
  frameId: string
}

/**
 * One unit the model files: a frame (a sheet with its variants, or a whole
 * design), or the frames of one family when the source cut its variants
 * into cards. A family always lands in one category.
 */
export interface CurationEntry {
  /** stable: `<canvasId>:<frameId>` of its first frame */
  key: string
  label: string
  /** the family id, when the name or the index carries one */
  itemId: string | null
  frames: FrameRef[]
  /** the source page of its first frame, as named there */
  sourcePage: string
  /** short visible text */
  text: string
  /** a description the source library already had */
  description: string
  width: number
  height: number
  /** variants it holds (cells of a sheet, or the other cards of its family) */
  variants: number
}

export interface CurationNode {
  id: string
  name: string
  children: CurationNode[]
}

export interface CurationDuplicate {
  /** the entry kept in its place */
  keep: string
  dropped: FrameRef & { name: string }
  reason: 'same-html' | 'same-content'
}

export interface CurationPlan {
  tree: CurationNode[]
  entries: CurationEntry[]
  /** entry key → node id; an entry without one is unclassified */
  assignments: Record<string, string>
  duplicates: CurationDuplicate[]
  /** the tree came from the page names, not from a model */
  fallback?: boolean
  /** entries one of the person's other libraries already holds (kept, shown in review) */
  existing?: { key: string; label: string; match: DuplicateMatch }[]
}

export interface CurationProgress {
  done: number
  total: number
}

/** How far an apply got: what makes it resumable and idempotent. */
export interface CurationApplyState {
  canvasId: string | null
  /** node id → page id on the new canvas */
  pageIds: Record<string, string>
  /** `<canvasId>:<frameId>` of a source frame → its copy */
  copied: Record<string, string>
  libraryCreated: boolean
}

export interface CurationJob {
  id: string
  ownerId: string
  sourceIds: string[]
  /** the name of the canvas apply creates */
  name: string
  status: CurationStatus
  progress: CurationProgress
  error: string | null
  plan: CurationPlan | null
  /** what the model calls consumed, per model */
  usage: TokenUsage[]
  calls: number
  /** the model that ran, for the review screen */
  model: string | null
  applied: CurationApplyState | null
  createdAt: number
  updatedAt: number
}

/* ---------------------------------------------------------------- */
/* names                                                             */
/* ---------------------------------------------------------------- */

/** A category name as people should read it: no numbers, no letter
 *  ranges, no path separators, short. '' when nothing usable is left. */
export function cleanCategoryName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const flat = raw.replace(/[/\\·|]+/g, ' ').replace(/\s+/g, ' ')
  const tidy = tidyCategoryPart(flat)
  if (!tidy) return ''
  const cut = tidy.length > MAX_NAME ? tidy.slice(0, MAX_NAME).replace(/\s+\S*$/, '') || tidy.slice(0, MAX_NAME) : tidy
  return cut.charAt(0).toUpperCase() + cut.slice(1)
}

/* ---------------------------------------------------------------- */
/* reading the model                                                 */
/* ---------------------------------------------------------------- */

/** The first JSON object in a model's answer (code fences and prose around it allowed). */
export function jsonOf(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('the model did not answer with JSON')
  return JSON.parse(text.slice(start, end + 1)) as unknown
}

interface RawNode {
  name?: unknown
  children?: unknown
}

/**
 * The model's proposed tree, read strictly: `{ categories: [{ name,
 * children? }] }`. Names are cleaned, siblings with the same name merged,
 * levels past the third dropped, leaves capped. Ids are minted here
 * (`c1`, `c2`… in reading order). Throws when fewer than two categories
 * survive, so the caller retries or falls back.
 */
export function parseTree(text: string, maxLeaves = MAX_CURATION_PAGES): CurationNode[] {
  const raw = jsonOf(text) as { categories?: unknown } | unknown[]
  const top = Array.isArray(raw) ? raw : (raw as { categories?: unknown }).categories
  if (!Array.isArray(top)) throw new Error('the answer has no categories list')
  let leaves = 0
  let next = 1
  const build = (list: unknown[], depth: number): CurationNode[] => {
    const out: CurationNode[] = []
    for (const item of list) {
      const node = (typeof item === 'string' ? { name: item } : item) as RawNode | null
      if (!node || typeof node !== 'object') continue
      const name = cleanCategoryName(node.name)
      if (!name) continue
      const kids = depth < MAX_CURATION_DEPTH && Array.isArray(node.children) ? node.children : []
      const same = out.find((n) => n.name.toLowerCase() === name.toLowerCase())
      if (same) {
        same.children.push(...build(kids, depth + 1).filter((k) => !same.children.some((c) => c.name === k.name)))
        continue
      }
      if (leaves >= maxLeaves) break
      const built: CurationNode = { id: `c${next++}`, name, children: [] }
      built.children = build(kids, depth + 1)
      if (!built.children.length) leaves++
      out.push(built)
    }
    return out
  }
  const tree = build(top, 1)
  if (countNodes(tree) < 2) throw new Error('the answer proposes fewer than two categories')
  return tree
}

/**
 * The model's filing of one batch: `{ a: { "<n>": "<node id>" } }` or
 * `{ a: [[n, id], …] }`. Only line numbers of the batch and ids of the tree
 * are kept; `none` and anything unknown are left out (the caller retries
 * those once, then leaves them unclassified).
 */
export function parseAssignments(text: string, batchSize: number, nodeIds: ReadonlySet<string>): Map<number, string> {
  const raw = jsonOf(text) as Record<string, unknown>
  const body = raw.a ?? raw.assignments ?? raw
  const pairs: [unknown, unknown][] = Array.isArray(body)
    ? body.flatMap((p: unknown) =>
        Array.isArray(p) && p.length >= 2
          ? [[p[0], p[1]] as [unknown, unknown]]
          : p && typeof p === 'object'
            ? [
                [(p as { n?: unknown }).n, (p as { c?: unknown; id?: unknown }).c ?? (p as { id?: unknown }).id] as [
                  unknown,
                  unknown,
                ],
              ]
            : [],
      )
    : body && typeof body === 'object'
      ? Object.entries(body as Record<string, unknown>)
      : []
  const out = new Map<number, string>()
  for (const [n, id] of pairs) {
    const at = typeof n === 'number' ? n : typeof n === 'string' ? Number(n) : NaN
    if (!Number.isInteger(at) || at < 1 || at > batchSize || out.has(at)) continue
    if (typeof id !== 'string' || !nodeIds.has(id)) continue
    out.set(at, id)
  }
  return out
}

/* ---------------------------------------------------------------- */
/* the tree                                                          */
/* ---------------------------------------------------------------- */

export function countNodes(tree: CurationNode[]): number {
  return tree.reduce((n, node) => n + 1 + countNodes(node.children), 0)
}

/** Every node with its path (`Heroes/AI products`) and depth, in reading order. */
export function flattenTree(
  tree: CurationNode[],
  parent: { path: string; depth: number } = { path: '', depth: 0 },
): { node: CurationNode; path: string; depth: number; parentId: string | null }[] {
  const out: { node: CurationNode; path: string; depth: number; parentId: string | null }[] = []
  const walk = (nodes: CurationNode[], path: string, depth: number, parentId: string | null) => {
    for (const node of nodes) {
      const p = path ? `${path}/${node.name}` : node.name
      out.push({ node, path: p, depth: depth + 1, parentId })
      walk(node.children, p, depth + 1, node.id)
    }
  }
  walk(tree, parent.path, parent.depth, null)
  return out
}

export function findNode(tree: CurationNode[], id: string): CurationNode | undefined {
  for (const node of tree) {
    if (node.id === id) return node
    const inner = findNode(node.children, id)
    if (inner) return inner
  }
  return undefined
}

function parentList(tree: CurationNode[], id: string): CurationNode[] | undefined {
  if (tree.some((n) => n.id === id)) return tree
  for (const node of tree) {
    const inner = parentList(node.children, id)
    if (inner) return inner
  }
  return undefined
}

function subtreeIds(node: CurationNode): string[] {
  return [node.id, ...node.children.flatMap(subtreeIds)]
}

function heightOf(node: CurationNode): number {
  return 1 + Math.max(0, ...node.children.map(heightOf))
}

function depthOf(tree: CurationNode[], id: string): number {
  return flattenTree(tree).find((f) => f.node.id === id)?.depth ?? 0
}

function nextId(tree: CurationNode[]): string {
  const max = flattenTree(tree).reduce((m, f) => Math.max(m, Number(f.node.id.slice(1)) || 0), 0)
  return `c${max + 1}`
}

/* ---------------------------------------------------------------- */
/* editing a plan (the review screen)                                */
/* ---------------------------------------------------------------- */

export type CurationEdit =
  | { op: 'rename'; id: string; name: string }
  | { op: 'merge'; from: string; into: string }
  | { op: 'delete'; id: string }
  | { op: 'move'; id: string; parentId: string | null; index?: number }
  | { op: 'add'; parentId: string | null; name: string }
  | { op: 'assign'; keys: string[]; to: string | null }

export type EditResult = { ok: true; plan: CurationPlan } | { ok: false; error: string }

/**
 * Apply one edit to a plan, returning a new plan (the input is not
 * changed). Merging moves the items and the sub-categories of `from` into
 * `into`; deleting a category leaves its items (and its sub-categories'
 * items) unclassified; moving keeps the tree at three levels.
 */
export function editPlan(plan: CurationPlan, edit: CurationEdit): EditResult {
  const next: CurationPlan = structuredClone(plan)
  const { tree } = next
  const fail = (error: string): EditResult => ({ ok: false, error })
  switch (edit.op) {
    case 'rename': {
      const node = findNode(tree, edit.id)
      if (!node) return fail('no such category')
      const name = cleanCategoryName(edit.name)
      if (!name) return fail('a category needs a name')
      const siblings = parentList(tree, edit.id) ?? []
      if (siblings.some((s) => s.id !== node.id && s.name.toLowerCase() === name.toLowerCase())) {
        return fail('a category beside it already has that name; merge them instead')
      }
      node.name = name
      return { ok: true, plan: next }
    }
    case 'merge': {
      if (edit.from === edit.into) return fail('a category cannot merge into itself')
      const from = findNode(tree, edit.from)
      const into = findNode(tree, edit.into)
      if (!from || !into) return fail('no such category')
      if (subtreeIds(from).includes(into.id)) return fail('a category cannot merge into one of its own')
      const room = MAX_CURATION_DEPTH - depthOf(tree, into.id)
      for (const child of from.children) {
        if (heightOf(child) > room) return fail('merging there would make the tree deeper than three levels')
      }
      for (const [key, id] of Object.entries(next.assignments)) if (id === from.id) next.assignments[key] = into.id
      for (const child of from.children) {
        const same = into.children.find((c) => c.name.toLowerCase() === child.name.toLowerCase())
        if (same) {
          for (const [key, id] of Object.entries(next.assignments)) if (id === child.id) next.assignments[key] = same.id
          same.children.push(...child.children)
        } else into.children.push(child)
      }
      const list = parentList(tree, from.id)!
      list.splice(list.indexOf(from), 1)
      return { ok: true, plan: next }
    }
    case 'delete': {
      const node = findNode(tree, edit.id)
      if (!node) return fail('no such category')
      const gone = new Set(subtreeIds(node))
      for (const [key, id] of Object.entries(next.assignments)) if (gone.has(id)) delete next.assignments[key]
      const list = parentList(tree, node.id)!
      list.splice(list.indexOf(node), 1)
      return { ok: true, plan: next }
    }
    case 'move': {
      const node = findNode(tree, edit.id)
      if (!node) return fail('no such category')
      let target: CurationNode[] = tree
      let depth = 0
      if (edit.parentId) {
        const parent = findNode(tree, edit.parentId)
        if (!parent) return fail('no such category')
        if (subtreeIds(node).includes(parent.id)) return fail('a category cannot move into one of its own')
        target = parent.children
        depth = depthOf(tree, parent.id)
      }
      if (depth + heightOf(node) > MAX_CURATION_DEPTH) return fail('the tree has at most three levels')
      if (target.some((s) => s.id !== node.id && s.name.toLowerCase() === node.name.toLowerCase())) {
        return fail('a category there already has that name; merge them instead')
      }
      const list = parentList(tree, node.id)!
      list.splice(list.indexOf(node), 1)
      const at = Math.max(0, Math.min(target.length, edit.index ?? target.length))
      target.splice(at, 0, node)
      return { ok: true, plan: next }
    }
    case 'add': {
      const name = cleanCategoryName(edit.name)
      if (!name) return fail('a category needs a name')
      let target: CurationNode[] = tree
      if (edit.parentId) {
        const parent = findNode(tree, edit.parentId)
        if (!parent) return fail('no such category')
        if (depthOf(tree, parent.id) >= MAX_CURATION_DEPTH) return fail('the tree has at most three levels')
        target = parent.children
      }
      if (target.some((s) => s.name.toLowerCase() === name.toLowerCase())) return fail('that category exists')
      target.push({ id: nextId(tree), name, children: [] })
      return { ok: true, plan: next }
    }
    case 'assign': {
      if (edit.to && !findNode(tree, edit.to)) return fail('no such category')
      const known = new Set(next.entries.map((e) => e.key))
      for (const key of edit.keys) {
        if (!known.has(key)) continue
        if (edit.to) next.assignments[key] = edit.to
        else delete next.assignments[key]
      }
      return { ok: true, plan: next }
    }
  }
}

/** Parse an edit sent over the wire; null when it is not one. */
export function readEdit(raw: unknown): CurationEdit | null {
  const b = (raw ?? {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' && v.length <= 200 ? v : null)
  switch (b.op) {
    case 'rename':
      return str(b.id) && str(b.name) !== null ? { op: 'rename', id: b.id as string, name: b.name as string } : null
    case 'merge':
      return str(b.from) && str(b.into) ? { op: 'merge', from: b.from as string, into: b.into as string } : null
    case 'delete':
      return str(b.id) ? { op: 'delete', id: b.id as string } : null
    case 'move':
      return str(b.id) && (b.parentId === null || str(b.parentId))
        ? {
            op: 'move',
            id: b.id as string,
            parentId: (b.parentId as string | null) ?? null,
            ...(Number.isInteger(b.index) ? { index: b.index as number } : {}),
          }
        : null
    case 'add':
      return (b.parentId === null || b.parentId === undefined || str(b.parentId)) && str(b.name)
        ? { op: 'add', parentId: (b.parentId as string | null | undefined) ?? null, name: b.name as string }
        : null
    case 'assign':
      return Array.isArray(b.keys) &&
        b.keys.length <= 5000 &&
        b.keys.every((k) => typeof k === 'string') &&
        (b.to === null || str(b.to))
        ? { op: 'assign', keys: b.keys as string[], to: (b.to as string | null) ?? null }
        : null
    default:
      return null
  }
}

/* ---------------------------------------------------------------- */
/* the review summary                                                */
/* ---------------------------------------------------------------- */

export interface CurationSample {
  key: string
  label: string
  frames: FrameRef[]
}

export interface CurationCategoryView {
  id: string
  name: string
  path: string
  /** items filed on this category itself */
  own: number
  /** items in it and every category under it */
  count: number
  /** frames those items hold */
  frames: number
  samples: CurationSample[]
  children: CurationCategoryView[]
}

export interface CurationPlanView {
  tree: CurationCategoryView[]
  totals: {
    entries: number
    frames: number
    duplicates: number
    unclassified: number
    pages: number
    /** items another library of the person already holds */
    existing: number
  }
  duplicates: CurationDuplicate[]
  existing: { key: string; label: string; match: DuplicateMatch }[]
  unclassified: CurationSample[]
  fallback: boolean
}

const SAMPLES = 6
const LIST_CAP = 500

/** What the review screen shows: counts and samples per category, the
 *  duplicates and the unclassified items (each list capped). */
export function planView(plan: CurationPlan, samples = SAMPLES): CurationPlanView {
  const byNode = new Map<string, CurationEntry[]>()
  const ids = new Set(flattenTree(plan.tree).map((f) => f.node.id))
  const unclassified: CurationEntry[] = []
  for (const entry of plan.entries) {
    const id = plan.assignments[entry.key]
    if (id && ids.has(id)) byNode.set(id, [...(byNode.get(id) ?? []), entry])
    else unclassified.push(entry)
  }
  const sample = (e: CurationEntry): CurationSample => ({ key: e.key, label: e.label, frames: e.frames.slice(0, 1) })
  const build = (nodes: CurationNode[], path: string): CurationCategoryView[] =>
    nodes.map((node) => {
      const p = path ? `${path}/${node.name}` : node.name
      const children = build(node.children, p)
      const own = byNode.get(node.id) ?? []
      const deep = [...own, ...children.flatMap((c) => c.samples)]
      return {
        id: node.id,
        name: node.name,
        path: p,
        own: own.length,
        count: own.length + children.reduce((n, c) => n + c.count, 0),
        frames: own.reduce((n, e) => n + e.frames.length, 0) + children.reduce((n, c) => n + c.frames, 0),
        samples: own.length ? own.slice(0, samples).map(sample) : deep.slice(0, samples),
        children,
      }
    })
  const tree = build(plan.tree, '')
  return {
    tree,
    totals: {
      entries: plan.entries.length,
      frames: plan.entries.reduce((n, e) => n + e.frames.length, 0),
      duplicates: plan.duplicates.length,
      unclassified: unclassified.length,
      pages: pageNodes(plan).length,
      existing: plan.existing?.length ?? 0,
    },
    duplicates: plan.duplicates.slice(0, LIST_CAP),
    existing: (plan.existing ?? []).slice(0, LIST_CAP),
    unclassified: unclassified.slice(0, LIST_CAP).map(sample),
    fallback: !!plan.fallback,
  }
}

/** The categories that become pages: every node with items of its own, in
 *  tree order, with its path (the page's name and the items' category). */
export function pageNodes(plan: CurationPlan): { id: string; path: string; entries: CurationEntry[] }[] {
  const byNode = new Map<string, CurationEntry[]>()
  for (const entry of plan.entries) {
    const id = plan.assignments[entry.key]
    if (id) byNode.set(id, [...(byNode.get(id) ?? []), entry])
  }
  return flattenTree(plan.tree).flatMap((f) =>
    byNode.get(f.node.id)?.length ? [{ id: f.node.id, path: f.path, entries: byNode.get(f.node.id)! }] : [],
  )
}

/** The public view of a job (no entries; the plan is read on its own route). */
export interface CurationJobView {
  id: string
  name: string
  sourceIds: string[]
  status: CurationStatus
  progress: CurationProgress
  error: string | null
  calls: number
  model: string | null
  usage: TokenUsage[]
  canvasId: string | null
  createdAt: number
  updatedAt: number
}

export function jobView(job: CurationJob): CurationJobView {
  return {
    id: job.id,
    name: job.name,
    sourceIds: job.sourceIds,
    status: job.status,
    progress: job.progress,
    error: job.error,
    calls: job.calls,
    model: job.model,
    usage: job.usage,
    canvasId: job.applied?.canvasId ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
}
