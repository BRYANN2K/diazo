import { type Express, type Request, type Response } from 'express'
import { z } from 'zod'
import {
  BlenderError,
  finishBlenderOp,
  getBlenderOp,
  listBlenderOps,
  pollBlenderOps,
  submitBlenderOp,
} from './blenderOps.ts'
import { canAccessCanvas, canEditCanvas } from './access.ts'
import { store } from './store.ts'

const submit = z
  .object({
    canvasId: z.string().min(1).max(100),
    tool: z.string().min(1).max(60),
    args: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
const poll = z.object({ deviceId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/) }).strict()
const finish = z
  .object({
    deviceId: z.string().min(1).max(100),
    state: z.enum(['done', 'failed']),
    result: z.unknown().optional(),
    error: z.string().max(2000).optional(),
  })
  .strict()

// Express 4 does not forward rejected promises without this boundary.
function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response) => {
    void fn(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        res.status(error instanceof BlenderError || error instanceof z.ZodError ? 400 : 500).json({
          error: error instanceof BlenderError ? error.message : 'blender request failed',
        })
      }
    })
  }
}

export function registerBlenderRoutes(app: Express): void {
  app.use('/api/blender', (_req, res, next) => {
    res.setHeader('cache-control', 'no-store')
    next()
  })

  app.get(
    '/api/blender/ops',
    handle(async (req, res) => {
      const canvas = store.getCanvas(String(req.query.canvasId ?? ''))
      if (!canvas || !canAccessCanvas(req.user!.id, canvas)) return res.status(404).end()
      return res.json({ ops: await listBlenderOps(req.user!.id, canvas.id) })
    }),
  )
  app.post(
    '/api/blender/ops',
    handle(async (req, res) => {
      const input = submit.parse(req.body)
      const canvas = store.getCanvas(input.canvasId)
      if (!canvas || !canAccessCanvas(req.user!.id, canvas)) return res.status(404).end()
      if (!canEditCanvas(req.user!.id, canvas)) return res.status(403).json({ error: 'canvas edit access required' })
      return res.status(201).json({ op: await submitBlenderOp(req.user!.id, canvas.id, input) })
    }),
  )
  app.get(
    '/api/blender/ops/:id',
    handle(async (req, res) => {
      const op = await getBlenderOp(req.params.id ?? '')
      if (!op || op.requestedBy !== req.user!.id) return res.status(404).end()
      return res.json({ op })
    }),
  )
  app.post(
    '/api/blender/poll',
    handle(async (req, res) => {
      const body = poll.parse(req.body)
      return res.json({ ops: await pollBlenderOps(body.deviceId, req.user!.id) })
    }),
  )
  app.post(
    '/api/blender/finish/:id',
    handle(async (req, res) => {
      const body = finish.parse(req.body)
      const op = await getBlenderOp(req.params.id ?? '', true)
      if (!op || op.requestedBy !== req.user!.id || op.deviceId !== body.deviceId) return res.status(404).end()
      if (op.state !== 'running') return res.status(409).json({ error: 'op is not running' })
      return res.json({ op: await finishBlenderOp(op, body) })
    }),
  )
}
