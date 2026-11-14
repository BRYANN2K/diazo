/**
 * AI library curation: read several source canvases, fold their
 * duplicates, let a model propose ONE category tree from the items
 * themselves and file every item in it. The result is a plan a person
 * reviews (shared/libraryCuration.ts) before `applyCuration`
 * (server/libraryCurationApply.ts) writes anything.
 *
 * - Sources are read frame by frame through `store.renderableFrame` (one
 *   frame's HTML, never a whole canvas), and never written.
 * - The models are the requester's own connected account
 *   (`accountTurnModels`): the configured model proposes the tree, its
 *   small tier files the items in batches. No account, no curation: the
 *   server tier is never spent on a job like this.
 * - Cost is bounded: a compact digest per item (name, page, a little text,
 *   size), batches of BATCH items, at most MAX_CALLS calls per job.
 * - Every answer is read strictly; a bad one is retried, then split, then
 *   left unclassified for the person. A tree the model cannot give falls
 *   back to one read from the page names.
 * - The job is saved as it goes and resumed after a restart from the
 *   items still unfiled.
 */
import { createHash } from 'node:crypto'
import { nanoid } from 'nanoid'
import {
  CURATION_WORKING,
  MAX_CURATION_ENTRIES,
  MAX_CURATION_PAGES,
  MAX_CURATION_SOURCES,
  cleanCategoryName,
  editPlan,
  flattenTree,
  parseAssignments,
  parseTree,
  type CurationDuplicate,
  type CurationEdit,
  type CurationEntry,
  type CurationJob,
  type CurationNode,
  type CurationPlan,
  type FrameRef,
} from '../shared/libraryCuration.ts'
import { parentIdOf, splitFrameName } from '../shared/libraryIds.ts'
import { isIgnoredName, RULE_PRESETS, sectionCategory, tidyCategoryPart } from '../shared/libraryRules.ts'
import { readingOrder } from '../shared/frameOrder.ts'
import { canvasPages, framePageId } from '../shared/pages.ts'
import { addUsage, type TokenUsage } from '../shared/usage.ts'
import type { Frame } from '../shared/types.ts'
import type { LibraryItem } from '../shared/library.ts'
import * as persist from './db/persist.ts'
import { store } from './store.ts'
import { canManageCanvas } from './access.ts'
import { getLibrary, presetFor } from './libraries.ts'
import { libraryItems } from './libraryIndex.ts'
import { accountTurnModels, ModelAuthError } from './agentModel.ts'

/** Items per filing call. */
export const BATCH = 60
/** Filing calls running at once. */
export const CONCURRENCY = 3
/** The hard cap on model calls per job (tree included). */
export const MAX_CALLS = 400
/** Entries shown to the model when it proposes the tree. */
export const TREE_SAMPLE = 450
const TEXT = 100
const DESCRIPTION = 80
const LABEL = 80
const SAVE_EVERY_MS = 2000

/* ---------------------------------------------------------------- */
/* the model                                                         */
/* ---------------------------------------------------------------- */

export interface CurationTurn {
  system: string
  user: string
  maxTokens: number
}

/** One text-in, text-out call; the usage feeds the job's meter. */
export interface CurationModel {
  label: string
  complete(turn: CurationTurn): Promise<{ text: string; usage?: TokenUsage }>
}

export interface CurationModels {
  /** proposes the tree */
  main: CurationModel
  /** files the items */
  bulk: CurationModel
}

export class CurationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message)
  }
}

async function accountModels(ownerId: string): Promise<CurationModels | null> {
  const models = await accountTurnModels(ownerId)
  if (!models) return null
  const wrap = (model: (typeof models)['main']): CurationModel => ({
    label: model.label,
    async complete(turn) {
      const result = await model.run({
        system: [{ text: turn.system, cache: true }],
        tools: [],
        messages: [{ role: 'user', content: turn.user }],
        maxTokens: turn.maxTokens,
        signal: AbortSignal.timeout(120_000),
      })
      const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
      return { text, ...(result.usage ? { usage: result.usage } : {}) }
    },
  })
  return { main: wrap(models.main), bulk: wrap(models.bulk) }
}

let resolveModels: (ownerId: string) => Promise<CurationModels | null> = accountModels

/** Tests swap the model calls. */
export function setCurationModels(fn: ((ownerId: string) => Promise<CurationModels | null>) | null): void {
  resolveModels = fn ?? accountModels
}

/* ---------------------------------------------------------------- */
/* reading the sources                                               */
/* ---------------------------------------------------------------- */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

/** The words a frame shows, short: no scripts, styles, SVG or tags. */
export function visibleText(html: string, max = TEXT): string {
  return html
    .replace(/<(script|style|svg|template|noscript|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#?\w+);/g, (m, e: string) => ENTITIES[e.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/** A frame's markup with what differs between copies (element ids,
 *  whitespace) left out, hashed: two equal signatures are one design. */
export function htmlSignature(html: string): string {
  const normal = html
    .replace(/\s+data-doop-(?:id|ref-rev|ref-lib)="[^"]*"/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return createHash('sha1').update(normal).digest('hex').slice(0, 20)
}

/** Label and text reduced to what a near-identical copy shares. */
export function contentKey(label: string, text: string): string | null {
  const fold = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
  const t = fold(text).slice(0, 200)
  if (t.length < 24) return null
  return `${fold(label)}|${t}`
}

/** What gathering needs of one frame. */
export interface SourceFrame {
  canvasId: string
  frame: Pick<Frame, 'id' | 'name' | 'width' | 'height'>
  pageName: string
  html: string
  /** from the source's index, when it is a library */
  indexed?: { itemId: string; parentId: string | null; label: string; description: string; variants: number }
}

export interface Gathered {
  entries: CurationEntry[]
  duplicates: CurationDuplicate[]
}

interface Built extends CurationEntry {
  sig: string
  content: string | null
}

/**
 * Turn the frames of the sources (in the order given: the first source
 * wins a duplicate) into entries. A frame with the same markup as one
 * already kept, or the same label and text as one kept from ANOTHER source,
 * is a duplicate. Cards of one family (an id extending another frame's id on
 * the same canvas) join that family's entry.
 */
export function buildEntries(frames: SourceFrame[]): Gathered {
  const entries: Built[] = []
  const duplicates: CurationDuplicate[] = []
  const bySig = new Map<string, Built>()
  const byContent = new Map<string, Built>()
  const byCanvas = new Map<string, SourceFrame[]>()
  for (const f of frames) byCanvas.set(f.canvasId, [...(byCanvas.get(f.canvasId) ?? []), f])
  for (const [canvasId, list] of byCanvas) {
    const named = list.map((f) => {
      const split = splitFrameName(f.frame.name)
      return { f, id: f.indexed?.itemId ?? split.id, label: f.indexed?.label || split.label || f.frame.name }
    })
    const families = new Map<string, Built>()
    const ids = named.flatMap((n) => (n.id ? [n.id] : []))
    for (const n of [...named].sort((a, b) => (a.id?.length ?? 0) - (b.id?.length ?? 0))) {
      const { f, id, label } = n
      const ref: FrameRef = { canvasId, frameId: f.frame.id }
      const text = visibleText(f.html)
      const sig = htmlSignature(f.html)
      const content = contentKey(label, text)
      const twin = bySig.get(sig) ?? (content ? byContent.get(content) : undefined)
      const crossSource = twin && (bySig.get(sig) === twin || twin.frames[0]!.canvasId !== canvasId)
      if (twin && crossSource) {
        duplicates.push({
          keep: twin.key,
          dropped: { ...ref, name: f.frame.name },
          reason: bySig.get(sig) === twin ? 'same-html' : 'same-content',
        })
        continue
      }
      const parentId =
        f.indexed?.parentId ??
        (id
          ? parentIdOf(
              id,
              ids.filter((other) => other !== id && families.has(other)),
            )
          : null)
      const family = parentId ? families.get(parentId) : undefined
      if (family) {
        family.frames.push(ref)
        family.variants++
        bySig.set(sig, family)
        continue
      }
      const entry: Built = {
        key: `${canvasId}:${f.frame.id}`,
        label: label.slice(0, LABEL),
        itemId: id,
        frames: [ref],
        sourcePage: f.pageName,
        text,
        description: (f.indexed?.description ?? '').slice(0, DESCRIPTION),
        width: f.frame.width,
        height: f.frame.height,
        variants: f.indexed?.variants ?? 0,
        sig,
        content,
      }
      entries.push(entry)
      if (id) families.set(id, entry)
      bySig.set(sig, entry)
      if (content && !byContent.has(content)) byContent.set(content, entry)
    }
  }
  /* back to the sources' reading order (families were built shortest id first) */
  const order = new Map(frames.map((f, i) => [`${f.canvasId}:${f.frame.id}`, i]))
  entries.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0))
  return { entries: entries.map(({ sig: _s, content: _c, ...e }) => e), duplicates }
}

/** What a source library's index says of each frame: its family (with
 *  the variant count), or the one card it holds and the family it joins. */
export function indexedFrames(items: LibraryItem[]): Map<string, NonNullable<SourceFrame['indexed']>> {
  const variants = new Map<string, number>()
  for (const item of items) if (item.parentId) variants.set(item.parentId, (variants.get(item.parentId) ?? 0) + 1)
  const out = new Map<string, NonNullable<SourceFrame['indexed']>>()
  const of = (item: LibraryItem, parentId: string | null) => ({
    itemId: item.itemId,
    parentId,
    label: item.label,
    description: item.description,
    variants: parentId ? 0 : (variants.get(item.itemId) ?? 0),
  })
  for (const item of items) if (!item.parentId) out.set(item.frameId, of(item, null))
  const frameOf = new Map(items.map((i) => [i.itemId, i.frameId]))
  for (const item of items) {
    if (out.has(item.frameId) || !item.parentId) continue
    /* a card: its family lives in another frame */
    if (frameOf.get(item.parentId) !== item.frameId) out.set(item.frameId, of(item, item.parentId))
  }
  return out
}

/** Read every frame of the sources that can be an item, in reading order:
 *  section headers, page titles and indexes (the source's rules) are left out. */
async function readSources(
  sourceIds: string[],
  onFrame: (done: number, total: number) => void,
): Promise<SourceFrame[]> {
  const plan = sourceIds.flatMap((id) => {
    const canvas = store.getCanvas(id)
    if (!canvas) return []
    const rules = getLibrary(id)?.rules ?? RULE_PRESETS[presetFor(canvas)]
    return canvasPages(canvas).flatMap((page) =>
      readingOrder(canvas.frames.filter((f) => framePageId(canvas, f) === page.id && !f.demo))
        .filter((f) => !isIgnoredName(rules, f.name) && !sectionCategory(rules.detect.section, f.name))
        .map((f) => ({ canvasId: id, frame: f, pageName: page.name })),
    )
  })
  const indexed = new Map<string, Map<string, NonNullable<SourceFrame['indexed']>>>()
  for (const id of sourceIds) {
    if (getLibrary(id)) indexed.set(id, indexedFrames(await libraryItems(id)))
  }
  const out: SourceFrame[] = []
  let done = 0
  for (const p of plan) {
    const frame = await store.renderableFrame(p.frame.id)
    done++
    if (done % 50 === 0 || done === plan.length) onFrame(done, plan.length)
    if (!frame) continue
    const known = indexed.get(p.canvasId)?.get(frame.id)
    out.push({
      canvasId: p.canvasId,
      frame: { id: frame.id, name: frame.name, width: frame.width, height: frame.height },
      pageName: p.pageName,
      html: frame.html,
      ...(known ? { indexed: known } : {}),
    })
    if (out.length > MAX_CURATION_ENTRIES * 2) break
  }
  return out
}

/* ---------------------------------------------------------------- */
/* the prompts                                                       */
/* ---------------------------------------------------------------- */

const one = (s: string) => s.replace(/[|\n\r]+/g, ' ').trim()

const TREE_SYSTEM = `You organise a design library: thousands of UI designs (components, page sections, whole screens, motion and type studies) gathered from several canvases. Their page names are messy: numbered, split alphabetically ("A–L", "L–Z") and grouped by layout rather than by what the designs are.

Propose ONE category tree a designer would browse, built from what the items ARE (their names and text), not from the old page names:
- at most 3 levels; 6 to 14 top-level categories; 25 to 80 categories without children in total;
- short human names, 1 to 4 words, sentence case; no numbers, no letter ranges, no vendor or source names, no "Misc", "Other" or "Unsorted";
- group by what a thing is first, then by what helps choosing: e.g. "Heroes" → by industry ("AI products", "Fintech"); "Sections" → "Pricing", "FAQ", "Call to action", "Testimonials"; "Components" → "Buttons", "Cards", "Inputs"; "Motion" → "Loaders", "Transitions";
- the variants of one design always sit in one category, so never split by colour, theme or size.

Answer with JSON only, no prose: {"categories":[{"name":"Heroes","children":[{"name":"AI products"},{"name":"Fintech"}]},{"name":"Components","children":[{"name":"Buttons"}]}]}`

/** The items the tree is proposed from: a spread over every source page
 *  (evenly spaced inside each), topped up round-robin to `size`. */
export function treeSample(entries: CurationEntry[], size = TREE_SAMPLE): CurationEntry[] {
  const byPage = new Map<string, CurationEntry[]>()
  for (const e of entries) byPage.set(e.sourcePage, [...(byPage.get(e.sourcePage) ?? []), e])
  const pages = [...byPage.values()]
  const quota = Math.max(1, Math.floor(size / Math.max(1, pages.length)))
  const picked = new Set<CurationEntry>()
  for (const page of pages) {
    const take = Math.min(quota, page.length)
    for (let i = 0; i < take && picked.size < size; i++) picked.add(page[Math.floor((i * page.length) / take)]!)
  }
  for (let round = 0; picked.size < size && pages.some((p) => p.length > round); round++) {
    for (const page of pages) {
      if (picked.size >= size) break
      const e = page[round]
      if (e) picked.add(e)
    }
  }
  return [...picked]
}

export function treePrompt(entries: CurationEntry[]): string {
  const pages = new Map<string, number>()
  for (const e of entries) pages.set(e.sourcePage, (pages.get(e.sourcePage) ?? 0) + 1)
  const sample = treeSample(entries)
  return [
    `The library holds ${entries.length} items on ${pages.size} source pages.`,
    '',
    'Source pages (name: items):',
    ...[...pages].slice(0, 200).map(([name, n]) => `- ${one(name)}: ${n}`),
    '',
    `A spread of ${sample.length} items (name | text):`,
    ...sample.map((e) => `- ${one(e.label)} | ${one(e.description || e.text).slice(0, 70)}`),
  ].join('\n')
}

function treeLines(tree: CurationNode[]): string[] {
  return flattenTree(tree).map((f) => `${f.node.id} ${f.path}`)
}

function classifySystem(tree: CurationNode[]): string {
  return `You file items of a design library into its categories. The categories, as "<id> <path>":
${treeLines(tree).join('\n')}

Each item is one line: "<n>|<name>|<old page>|<width>x<height>|<visible text>". File each one into the MOST specific category that fits what the design is (the old page name is only a hint). Answer with JSON only, no prose: {"a":{"1":"c12","2":"c4"}}, one entry per line number. Use "none" only when no category fits at all.`
}

export function batchPrompt(batch: CurationEntry[]): string {
  return batch
    .map((e, i) =>
      [
        i + 1,
        one(e.label).slice(0, LABEL),
        one(e.sourcePage).slice(0, 60),
        `${Math.round(e.width)}x${Math.round(e.height)}`,
        one([e.description, e.text].filter(Boolean).join(' — ')).slice(0, TEXT + DESCRIPTION),
      ].join('|'),
    )
    .join('\n')
}

/* ---------------------------------------------------------------- */
/* the fallback: a tree from the page names                          */
/* ---------------------------------------------------------------- */

/** A tree read from the tidied page names (`01 Heroes · AI products · A–L`
 *  → Heroes / AI products), and every entry filed by its page. */
export function heuristicPlan(entries: CurationEntry[]): Pick<CurationPlan, 'tree' | 'assignments'> {
  const tree: CurationNode[] = []
  const assignments: Record<string, string> = {}
  let next = 1
  const child = (list: CurationNode[], name: string) => {
    let node = list.find((n) => n.name.toLowerCase() === name.toLowerCase())
    if (!node) list.push((node = { id: `c${next++}`, name, children: [] }))
    return node
  }
  for (const e of entries) {
    const parts = e.sourcePage
      .replace(/\s+—\s+title$/i, '')
      .split(' · ')
      .map((p) => cleanCategoryName(tidyCategoryPart(p)))
      .filter(Boolean)
    const top = child(tree, parts[0] ?? 'Unsorted')
    const leaf = parts[1] && top.children.length < MAX_CURATION_PAGES ? child(top.children, parts[1]) : top
    assignments[e.key] = leaf.id
  }
  return { tree, assignments }
}

/* ---------------------------------------------------------------- */
/* jobs                                                              */
/* ---------------------------------------------------------------- */

const jobs = new Map<string, CurationJob>()
const running = new Map<string, Promise<void>>()
const lastSaved = new Map<string, number>()

function save(job: CurationJob, force = false): Promise<void> {
  job.updatedAt = Date.now()
  const at = lastSaved.get(job.id) ?? 0
  if (!force && job.updatedAt - at < SAVE_EVERY_MS) return Promise.resolve()
  lastSaved.set(job.id, job.updatedAt)
  return persist.saveCuration(job)
}

/** Fill the jobs from the database at boot. */
export async function hydrateCurations(): Promise<void> {
  jobs.clear()
  for (const job of await persist.loadCurations()) jobs.set(job.id, job)
}

/** Save a job (throttled unless `force`): for the apply, which runs apart. */
export const saveCurationJob = save

/** Every job (the boot resume of applies). */
export function allCurations(): CurationJob[] {
  return [...jobs.values()]
}

export function getCuration(id: string): CurationJob | undefined {
  return jobs.get(id)
}

/** A person's jobs, newest first. */
export function curationsOf(ownerId: string): CurationJob[] {
  return [...jobs.values()].filter((j) => j.ownerId === ownerId).sort((a, b) => b.createdAt - a.createdAt)
}

/** For tests: forget every job. */
export function resetCurationsForTest(): void {
  jobs.clear()
  running.clear()
  lastSaved.clear()
}

/** Resolves once the job's background work is over (tests, apply). */
export function curationSettled(id: string): Promise<void> {
  return running.get(id) ?? Promise.resolve()
}

/**
 * Start a curation of `sourceIds` for `ownerId`, who must manage every
 * source. Throws a CurationError the routes answer with.
 */
export async function startCuration(input: {
  ownerId: string
  sourceIds: string[]
  name?: string
}): Promise<CurationJob> {
  const sourceIds = [...new Set(input.sourceIds)]
  if (!sourceIds.length || sourceIds.length > MAX_CURATION_SOURCES) {
    throw new CurationError(`pick 1 to ${MAX_CURATION_SOURCES} source canvases`)
  }
  for (const id of sourceIds) {
    const canvas = store.getCanvas(id)
    if (!canvas || !canManageCanvas(input.ownerId, canvas)) throw new CurationError(`canvas ${id} not found`, 404)
  }
  if (curationsOf(input.ownerId).some((j) => CURATION_WORKING.has(j.status) || j.status === 'applying')) {
    throw new CurationError('a curation of yours is already running; wait for it or cancel it', 409)
  }
  if (!(await resolveModels(input.ownerId))) {
    throw new CurationError(
      'connect a model account in Settings → Doop Agent first: curation runs on your own account',
      409,
    )
  }
  const first = store.getCanvas(sourceIds[0]!)!
  const now = Date.now()
  const job: CurationJob = {
    id: nanoid(12),
    ownerId: input.ownerId,
    sourceIds,
    name: (input.name?.trim() || `${first.name} (curated)`).slice(0, 120),
    status: 'gathering',
    progress: { done: 0, total: 0 },
    error: null,
    plan: null,
    usage: [],
    calls: 0,
    model: null,
    applied: null,
    createdAt: now,
    updatedAt: now,
  }
  jobs.set(job.id, job)
  await save(job, true)
  runInBackground(job)
  return job
}

function runInBackground(job: CurationJob) {
  if (running.has(job.id)) return
  const task = runJob(job)
    .catch(async (error: unknown) => {
      console.error('[curation] job stopped', job.id, error)
      job.status = 'failed'
      job.error = error instanceof Error ? error.message : String(error)
      await save(job, true)
    })
    .finally(() => running.delete(job.id))
  running.set(job.id, task)
}

/** Restart the jobs a restart cut off (once, at boot). */
export function resumeCurations(): void {
  for (const job of jobs.values()) if (CURATION_WORKING.has(job.status)) runInBackground(job)
}

/** Run a failed job again from where it stopped (the items still unfiled). */
export async function retryCuration(id: string): Promise<CurationJob> {
  const job = jobs.get(id)
  if (!job) throw new CurationError('curation not found', 404)
  if (job.status !== 'failed') throw new CurationError('only a failed curation can be retried', 409)
  job.status = job.plan ? (job.plan.tree.length ? 'classifying' : 'proposing') : 'gathering'
  job.error = null
  await save(job, true)
  runInBackground(job)
  return job
}

export async function cancelCuration(id: string): Promise<CurationJob> {
  const job = jobs.get(id)
  if (!job) throw new CurationError('curation not found', 404)
  if (job.status === 'applied' || job.status === 'applying') {
    throw new CurationError('this curation is being applied or was applied', 409)
  }
  job.status = 'cancelled'
  await save(job, true)
  return job
}

/** Edit the proposed plan (the review screen). Only a ready plan is edited. */
export async function editCuration(id: string, edits: CurationEdit[]): Promise<CurationJob> {
  const job = jobs.get(id)
  if (!job?.plan) throw new CurationError('curation not found', 404)
  if (job.status !== 'ready') throw new CurationError('the plan can be edited once it is ready', 409)
  let plan = job.plan
  for (const edit of edits) {
    const result = editPlan(plan, edit)
    if (!result.ok) throw new CurationError(result.error)
    plan = result.plan
  }
  job.plan = plan
  await save(job, true)
  return job
}

const stopped = (job: CurationJob) => jobs.get(job.id) !== job || job.status === 'cancelled'

async function call(job: CurationJob, model: CurationModel, turn: CurationTurn): Promise<string> {
  if (job.calls >= MAX_CALLS) throw new BudgetError()
  job.calls++
  job.model ??= model.label
  const { text, usage } = await model.complete(turn)
  if (usage) job.usage = addUsage(job.usage, usage)
  return text
}

class BudgetError extends Error {
  constructor() {
    super(`the curation reached its cap of ${MAX_CALLS} model calls`)
  }
}

/** An account error ends the job (the person must fix it); anything else
 *  is this one call's failure. */
const fatal = (error: unknown) => error instanceof ModelAuthError || error instanceof BudgetError

async function runJob(job: CurationJob): Promise<void> {
  const models = await resolveModels(job.ownerId)
  if (!models) throw new Error('no model account is connected any more; connect one in Settings and retry')

  if (job.status === 'gathering' || !job.plan) {
    job.status = 'gathering'
    const frames = await readSources(job.sourceIds, (done, total) => {
      job.progress = { done, total }
      void save(job)
    })
    if (stopped(job)) return
    const gathered = buildEntries(frames)
    job.plan = {
      tree: [],
      entries: gathered.entries.slice(0, MAX_CURATION_ENTRIES),
      assignments: {},
      duplicates: gathered.duplicates,
    }
    job.status = 'proposing'
    job.progress = { done: 0, total: 1 }
    await save(job, true)
  }
  const plan = job.plan

  if (job.status === 'proposing' || !plan.tree.length) {
    job.status = 'proposing'
    plan.tree = await proposeTree(job, models.main, plan.entries)
    if (stopped(job)) return
    if (!plan.tree.length) {
      const fallback = heuristicPlan(plan.entries)
      plan.tree = fallback.tree
      plan.assignments = fallback.assignments
      plan.fallback = true
    }
    job.status = 'classifying'
    await save(job, true)
  }

  if (job.status === 'classifying') {
    if (!plan.fallback) await classifyAll(job, models.bulk)
    if (stopped(job)) return
    job.status = 'ready'
    job.progress = { done: plan.entries.length, total: plan.entries.length }
    await save(job, true)
  }
}

async function proposeTree(job: CurationJob, model: CurationModel, entries: CurationEntry[]): Promise<CurationNode[]> {
  const user = treePrompt(entries)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await call(job, model, { system: TREE_SYSTEM, user, maxTokens: 4000 })
      return parseTree(text)
    } catch (error) {
      if (fatal(error)) throw error
      console.warn('[curation] the tree answer was unusable', job.id, error instanceof Error ? error.message : error)
    }
  }
  return []
}

/** File every entry not filed yet, BATCH at a time, CONCURRENCY at once.
 *  A failed batch is retried once, then split in two; whatever is still
 *  unfiled after one more pass is left for the person. */
async function classifyAll(job: CurationJob, model: CurationModel): Promise<void> {
  const plan = job.plan!
  const ids = new Set(flattenTree(plan.tree).map((f) => f.node.id))
  const system = classifySystem(plan.tree)
  const pending = () => plan.entries.filter((e) => !ids.has(plan.assignments[e.key] ?? ''))
  const total = plan.entries.length
  const progress = () => {
    job.progress = { done: total - pending().length, total }
  }

  const fileBatch = async (batch: CurationEntry[], tries: number): Promise<void> => {
    if (stopped(job) || !batch.length) return
    let filed: Map<number, string>
    try {
      const text = await call(job, model, { system, user: batchPrompt(batch), maxTokens: 40 + batch.length * 14 })
      filed = parseAssignments(text, batch.length, ids)
    } catch (error) {
      if (fatal(error)) throw error
      if (tries > 0) return fileBatch(batch, tries - 1)
      if (batch.length > 10) {
        const half = Math.ceil(batch.length / 2)
        await fileBatch(batch.slice(0, half), 0)
        await fileBatch(batch.slice(half), 0)
      }
      return
    }
    for (const [n, id] of filed) plan.assignments[batch[n - 1]!.key] = id
    progress()
    await save(job)
  }

  for (let pass = 0; pass < 2; pass++) {
    const queue = pending()
    const batches: CurationEntry[][] = []
    for (let at = 0; at < queue.length; at += BATCH) batches.push(queue.slice(at, at + BATCH))
    let next = 0
    const worker = async () => {
      while (next < batches.length && !stopped(job)) {
        const batch = batches[next++]!
        await fileBatch(batch, pass === 0 ? 1 : 0)
      }
    }
    const outcomes = await Promise.allSettled(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker))
    const errors = outcomes.flatMap((o) => (o.status === 'rejected' ? [o.reason as unknown] : []))
    const hard = errors.find((e) => !(e instanceof BudgetError))
    if (hard) throw hard
    /* the budget is a soft stop: the person files the rest */
    if (errors.length || !pending().length) break
  }
  progress()
}
