import express, { type Express, type Request, type Response } from 'express'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { db } from './db/index.ts'
import * as t from './db/schema.ts'
import * as speech from './speech.ts'
import { isAdmin } from './access.ts'
import { canAccessCanvas, canEditCanvas } from './access.ts'
import { store } from './store.ts'
import { speechRequestSchema, ROUTE_TARGETS } from '../shared/speech.ts'
import { completeSpeechJob, estimateSpeech, sniffSpeechAudio, submitSpeech } from './speechJobs.ts'
import { storeAsset } from './assets.ts'
import { speechProgress } from './actions.ts'

const preferences = z
  .object({
    transcribeTarget: z.enum(ROUTE_TARGETS),
    voiceTarget: z.enum(ROUTE_TARGETS),
    modelId: z.string().min(1).max(100).optional(),
    cloudProvider: z.enum(['elevenlabs', 'openai']).optional(),
    voiceProvider: z.enum(['local', 'elevenlabs']).optional(),
    voice: z.string().max(100).optional(),
    language: z.string().min(2).max(16).optional(),
    speakers: z.boolean(),
  })
  .strict()
const poll = z
  .object({ deviceId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), models: z.array(z.string().max(100)).max(100) })
  .strict()
const finish = z
  .object({
    deviceId: z.string().min(1).max(100),
    state: z.enum(['running', 'done', 'failed']),
    progress: z.number().finite().min(0).max(1).optional(),
    transcript: z.unknown().optional(),
    outputAssetId: z.string().max(100).optional(),
  })
  .strict()

// Express 4 does not forward rejected promises without this boundary.
function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response) => {
    void fn(req, res).catch((error: unknown) => {
      if (!res.headersSent)
        res.status(error instanceof speech.SpeechError || error instanceof z.ZodError ? 400 : 500).json({
          error:
            error instanceof speech.SpeechError
              ? error.message
              : error instanceof z.ZodError
                ? 'invalid speech request'
                : 'speech request failed',
        })
    })
  }
}

function requireCanvas(req: Request, res: Response, id: string, _role: 'edit') {
  const canvas = store.getCanvas(id)
  if (!canvas) {
    res.status(404).json({ error: 'no such canvas' })
    return undefined
  }
  if (!canEditCanvas(req.user?.id, canvas)) {
    res.status(403).json({ error: 'canvas edit access required' })
    return undefined
  }
  return canvas
}

export function registerSpeechRoutes(app: Express): void {
  app.use('/api/speech', (_req, res, next) => {
    if (!speech.speechEnabled()) return res.status(404).end()
    next()
  })
  app.get(
    '/api/speech/catalog',
    handle(async (req, res) => res.json(await speech.catalog(req.user!.id))),
  )
  app.get(
    '/api/speech/preferences',
    handle(async (req, res) => res.json(await speech.getPreferences(req.user!.id))),
  )
  app.put(
    '/api/speech/preferences',
    handle(async (req, res) => {
      const prefs = preferences.parse(req.body)
      await speech.savePreferences(req.user!.id, prefs)
      return res.json(prefs)
    }),
  )
  app.post(
    '/api/speech/estimate',
    handle(async (req, res) => res.json(estimateSpeech(speechRequestSchema.parse(req.body)))),
  )
  app.post(
    '/api/speech/jobs',
    handle(async (req, res) => {
      const { canvas_id, ...request } = z
        .object({ canvas_id: z.string().min(1) })
        .passthrough()
        .parse(req.body)
      if (!requireCanvas(req, res, canvas_id, 'edit')) return
      return res.status(201).json({ job: await submitSpeech(req.user!.id, canvas_id, request) })
    }),
  )
  app.get(
    '/api/speech/jobs/:id',
    handle(async (req, res) => {
      const job = await speech.getJob(req.params.id ?? '')
      if (!job || job.requestedBy !== req.user!.id) return res.status(404).end()
      const canvas = job.canvasId ? store.getCanvas(job.canvasId) : undefined
      if (!canvas || !canAccessCanvas(req.user!.id, canvas)) return res.status(403).end()
      return res.json({ job })
    }),
  )
  app.delete(
    '/api/speech/jobs/:id',
    handle(async (req, res) => {
      const job = await speech.finishJob(req.params.id ?? '', { state: 'canceled' }, req.user!.id)
      if (!job) return res.status(404).end()
      if (job.canvasId) speechProgress(job.canvasId, job)
      return res.json({ job })
    }),
  )
  for (const method of ['post', 'delete'] as const)
    app[method](
      '/api/speech/server/installs/:modelId',
      handle(async (req, res) => {
        if (!isAdmin(req.user)) return res.status(403).end()
        if (method === 'post')
          return res.status(201).json({ install: await speech.installOnServer(req.params.modelId ?? '', req.user!.id) })
        await speech.uninstallOnServer(req.params.modelId ?? '')
        return res.json({ ok: true })
      }),
    )
  app.post(
    '/api/speech/desktop/poll',
    handle(async (req, res) => {
      const body = poll.parse(req.body)
      return res.json({ jobs: await speech.pollDesktopJobs(body.deviceId, req.user!.id, body.models) })
    }),
  )
  app.post(
    '/api/speech/desktop/finish/:id',
    handle(async (req, res) => {
      const body = finish.parse(req.body)
      const job = await speech.getJob(req.params.id ?? '')
      if (!job || job.requestedBy !== req.user!.id || job.target !== 'desktop' || job.deviceId !== body.deviceId)
        return res.status(404).end()
      if (job.state !== 'running') return res.status(409).json({ error: 'job is not running' })
      if (body.state === 'done') {
        if (body.outputAssetId) {
          const [asset] = await db
            .select()
            .from(t.assets)
            .where(
              and(
                eq(t.assets.id, body.outputAssetId),
                eq(t.assets.canvasId, job.canvasId ?? ''),
                eq(t.assets.ownerId, req.user!.id),
              ),
            )
          if (!asset || !['audio/wav', 'audio/mpeg'].includes(asset.mime))
            throw new speech.SpeechError('no owned audio output for this job')
        }
        return res.json({ job: await completeSpeechJob(job, body.transcript, body.outputAssetId) })
      }
      const updated = await speech.finishJob(
        job.id,
        {
          state: body.state,
          progress: body.progress,
          ...(body.state === 'failed' ? { error: 'desktop speech processing failed' } : {}),
        },
        req.user!.id,
        body.deviceId,
      )
      if (updated?.canvasId) speechProgress(updated.canvasId, updated)
      return res.json({ job: updated })
    }),
  )
  app.put(
    '/api/speech/desktop/audio/:id',
    express.raw({ type: () => true, limit: 25 * 1024 * 1024 }),
    handle(async (req, res) => {
      const job = await speech.getJob(req.params.id ?? '')
      if (
        !job ||
        job.requestedBy !== req.user!.id ||
        job.target !== 'desktop' ||
        job.state !== 'running' ||
        job.kind !== 'speak' ||
        job.deviceId !== req.header('x-speech-device')
      )
        return res.status(404).end()
      if (!job.canvasId || !requireCanvas(req, res, job.canvasId, 'edit')) return
      if (!Buffer.isBuffer(req.body)) throw new speech.SpeechError('send raw audio bytes')
      const asset = await storeAsset(req.body, sniffSpeechAudio(req.body), {
        canvasId: job.canvasId,
        ownerId: req.user!.id,
        uploadedBy: req.user!.id,
      })
      return res.json({ asset })
    }),
  )
  app.get(
    '/api/speech/elevenlabs/voices',
    handle(async (req, res) =>
      res.json({
        voices: await speech.elevenLabsVoices(
          req.user!.id,
          typeof req.query.search === 'string' ? req.query.search : undefined,
        ),
      }),
    ),
  )
}
