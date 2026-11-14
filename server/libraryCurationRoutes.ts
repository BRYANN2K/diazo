/**
 * `/api/library-curations`: start an AI curation of several canvases, follow
 * it, review and edit the proposed plan, then apply it. Mounted behind the
 * session gate. A job is its requester's alone: anyone else gets 404, and
 * every source must be one the requester manages, when the job starts and
 * again when it is applied. Nothing but the job row is written before apply.
 */
import express from 'express'
import {
  MAX_CURATION_SOURCES,
  flattenTree,
  jobView,
  planView,
  readEdit,
  type CurationEdit,
  type CurationJob,
  type CurationSample,
} from '../shared/libraryCuration.ts'
import { canManageCanvas } from './access.ts'
import { store } from './store.ts'
import { getLibrary } from './libraries.ts'
import {
  cancelCuration,
  CurationError,
  curationsOf,
  editCuration,
  getCuration,
  retryCuration,
  startCuration,
} from './libraryCuration.ts'

export const curationRouter = express.Router()

const PAGE = 100

function mine(req: express.Request): CurationJob | null {
  const job = getCuration(String(req.params.id))
  return job && job.ownerId === req.user!.id ? job : null
}

function answerError(res: express.Response, error: unknown) {
  if (error instanceof CurationError) return res.status(error.status).json({ error: error.message })
  throw error
}

/** The canvases a person may curate from: the ones they manage, largest first. */
curationRouter.get('/sources', (req, res) => {
  const userId = req.user!.id
  const sources = [...store.canvases.values()]
    .filter((c) => canManageCanvas(userId, c))
    .map((c) => ({ id: c.id, name: c.name, frames: c.frames.length, library: !!getLibrary(c.id) }))
    .sort((a, b) => b.frames - a.frames || a.name.localeCompare(b.name))
  res.json({ sources, max: MAX_CURATION_SOURCES })
})

curationRouter.get('/', (req, res) => {
  res.json({ curations: curationsOf(req.user!.id).map(jobView) })
})

curationRouter.post('/', async (req, res) => {
  const sourceIds = Array.isArray(req.body?.sourceIds) ? (req.body.sourceIds as unknown[]).map(String) : []
  const name = typeof req.body?.name === 'string' ? req.body.name : undefined
  try {
    const job = await startCuration({ ownerId: req.user!.id, sourceIds, ...(name ? { name } : {}) })
    res.status(201).json(jobView(job))
  } catch (error) {
    answerError(res, error)
  }
})

curationRouter.get('/:id', (req, res) => {
  const job = mine(req)
  if (!job) return res.status(404).json({ error: 'curation not found' })
  res.json(jobView(job))
})

/** The proposed plan: the tree with counts and samples, the duplicates and
 *  what the model could not file. Empty until the items are gathered. */
curationRouter.get('/:id/plan', (req, res) => {
  const job = mine(req)
  if (!job) return res.status(404).json({ error: 'curation not found' })
  if (!job.plan) return res.status(409).json({ error: 'the sources are still being read' })
  res.json(planView(job.plan))
})

/** The items of one category (`category=<id>`) or the unclassified ones
 *  (`category=none`), PAGE at a time, for moving items by hand. */
curationRouter.get('/:id/items', (req, res) => {
  const job = mine(req)
  if (!job?.plan) return res.status(404).json({ error: 'curation not found' })
  const plan = job.plan
  const category = String(req.query.category ?? 'none')
  const ids = new Set(flattenTree(plan.tree).map((f) => f.node.id))
  if (category !== 'none' && !ids.has(category)) return res.status(404).json({ error: 'category not found' })
  const q = String(req.query.q ?? '')
    .trim()
    .toLowerCase()
  const matching = plan.entries.filter((e) => {
    const at = plan.assignments[e.key]
    const here = category === 'none' ? !at || !ids.has(at) : at === category
    return here && (!q || e.label.toLowerCase().includes(q) || e.text.toLowerCase().includes(q))
  })
  const from = Math.max(0, Number(req.query.cursor) || 0)
  const items: (CurationSample & { text: string; variants: number })[] = matching
    .slice(from, from + PAGE)
    .map((e) => ({ key: e.key, label: e.label, frames: e.frames.slice(0, 1), text: e.text, variants: e.variants }))
  res.json({
    items,
    total: matching.length,
    ...(from + PAGE < matching.length ? { cursor: String(from + PAGE) } : {}),
  })
})

/** Edit the plan: `{ edits: [{ op: 'rename' | 'merge' | 'delete' | 'move' | 'add' | 'assign', … }] }`,
 *  applied in order and all or nothing. Answers the new plan view. */
curationRouter.patch('/:id/plan', async (req, res) => {
  const job = mine(req)
  if (!job) return res.status(404).json({ error: 'curation not found' })
  const raw: unknown[] = Array.isArray(req.body?.edits) ? (req.body.edits as unknown[]) : []
  const edits = raw.map(readEdit)
  if (!edits.length || edits.length > 200 || edits.some((e) => !e)) {
    return res.status(400).json({ error: 'send 1 to 200 edits: rename, merge, delete, move, add or assign' })
  }
  try {
    const next = await editCuration(job.id, edits as CurationEdit[])
    res.json(planView(next.plan!))
  } catch (error) {
    answerError(res, error)
  }
})

curationRouter.post('/:id/retry', async (req, res) => {
  const job = mine(req)
  if (!job) return res.status(404).json({ error: 'curation not found' })
  try {
    res.json(jobView(await retryCuration(job.id)))
  } catch (error) {
    answerError(res, error)
  }
})

curationRouter.post('/:id/cancel', async (req, res) => {
  const job = mine(req)
  if (!job) return res.status(404).json({ error: 'curation not found' })
  try {
    res.json(jobView(await cancelCuration(job.id)))
  } catch (error) {
    answerError(res, error)
  }
})
