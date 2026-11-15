import { CLAUDE_EFFORTS, isClaudeModel } from '../shared/localAgent.ts'
import { Router, type Request, type Response } from 'express'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type ContentBlock } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { localAgentRuns } from './localAgentRuns.ts'
import { tokenUsageListSchema } from '../shared/usage.ts'
import { getLocalAgentPreference, saveLocalAgentPreference } from './localAgentPreferences.ts'
import { store } from './store.ts'
import { canEditCanvas } from './access.ts'
import { isBanned } from './auth.ts'
import { onFeedback } from './resident.ts'
import { getAcpPreference, saveAcpPreference } from './acpAgentPreferences.ts'
import { ACP_CATALOG_MAX, isAcpAgent, isAcpEffort, isAcpModel, type AcpAgent } from '../shared/acpAgent.ts'

export const localAgentRouter = Router()
/* an alias or a pinned claude-* id (the shell checks the shape again before
   it becomes a CLI argument), and the CLI's effort levels or none */
const preferenceSchema = z.object({
  enabled: z.boolean(),
  model: z.string().max(120).refine(isClaudeModel, 'Invalid model'),
  effort: z.enum(CLAUDE_EFFORTS).optional(),
})
const deviceSchema = z.object({ deviceId: z.string().uuid() })

localAgentRouter.get('/', (req, res, next) => {
  getLocalAgentPreference(req.user!.id)
    .then((preference) => res.json({ ...preference, online: localAgentRuns.online(req.user!.id) }))
    .catch(next)
})

localAgentRouter.put('/', (req, res, next) => {
  const parsed = preferenceSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid local agent preference' })
    return
  }
  const userId = req.user!.id
  void (async () => {
    if (!parsed.data.enabled) await localAgentRuns.cancel(userId)
    await saveLocalAgentPreference(userId, parsed.data)
    res.json(await getLocalAgentPreference(userId))
    wake(userId)
  })().catch(next)
})

/** Re-run the resident on every canvas this person can edit: a connection
 *  that just came on can make their queued work runnable. */
export function wake(userId: string) {
  for (const canvas of store.canvases.values()) if (canEditCanvas(userId, canvas)) onFeedback(canvas.id)
}

// POST: polling claims a run and is prohibited in read-only impersonation sessions.
localAgentRouter.post('/poll', (req, res, next) => {
  const parsed = deviceSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid device' })
    return
  }
  void (async () => {
    const userId = req.user!.id
    const preference = await getLocalAgentPreference(userId)
    if (!preference.enabled) {
      res.json({ job: null, enabled: false })
      return
    }
    const wasOnline = localAgentRuns.online(userId)
    const job = localAgentRuns.poll(userId, parsed.data.deviceId)
    res.json({ job, enabled: true })
    if (!wasOnline) wake(userId)
  })().catch(next)
})

localAgentRouter.post('/finish/:id', (req, res, next) => {
  const parsed = deviceSchema
    .extend({ success: z.boolean(), text: z.string().max(100_000), usage: tokenUsageListSchema.optional() })
    .safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid result' })
    return
  }
  localAgentRuns
    .finish(req.params.id!, req.user!.id, parsed.data.deviceId, parsed.data)
    .then((ok) => res.status(ok ? 200 : 409).json({ ok }))
    .catch(next)
})

localAgentRouter.post('/stop', (req, res, next) => {
  localAgentRuns
    .cancel(req.user!.id)
    .then(() => res.json({ ok: true }))
    .catch(next)
})

/* ---- the ACP agents (Devin, Grok): the same relay, one connection per
   agent. The desktop reports what its CLI lists while it polls. */

function acpAgentParam(req: Request, res: Response): AcpAgent | undefined {
  const agent = req.params.agent
  if (isAcpAgent(agent)) return agent
  res.status(404).json({ error: 'Unknown local agent' })
  return undefined
}

const catalogSchema = z
  .array(
    z.object({
      id: z.string().max(80).refine(isAcpModel),
      name: z.string().max(120),
      family: z.string().max(120).optional(),
    }),
  )
  .max(ACP_CATALOG_MAX)

localAgentRouter.get('/acp/:agent', (req, res, next) => {
  const agent = acpAgentParam(req, res)
  if (!agent) return
  const userId = req.user!.id
  getAcpPreference(userId, agent)
    .then((preference) => res.json({ ...preference, online: localAgentRuns.online(userId, Date.now(), agent) }))
    .catch(next)
})

localAgentRouter.put('/acp/:agent', (req, res, next) => {
  const agent = acpAgentParam(req, res)
  if (!agent) return
  const parsed = z
    .object({
      enabled: z.boolean(),
      model: z.string().max(80).refine(isAcpModel, 'Invalid model'),
      effort: z
        .string()
        .refine((effort) => isAcpEffort(agent, effort), 'Invalid effort')
        .optional(),
    })
    .safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid local agent preference' })
    return
  }
  const userId = req.user!.id
  void (async () => {
    if (!parsed.data.enabled) await localAgentRuns.cancel(userId, agent)
    const { enabled, model, effort } = parsed.data
    await saveAcpPreference(userId, agent, { enabled, model, ...(isAcpEffort(agent, effort) ? { effort } : {}) })
    res.json(await getAcpPreference(userId, agent))
    wake(userId)
  })().catch(next)
})

localAgentRouter.post('/acp/:agent/poll', (req, res, next) => {
  const agent = acpAgentParam(req, res)
  if (!agent) return
  const parsed = deviceSchema.extend({ catalog: catalogSchema.optional() }).safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid device' })
    return
  }
  void (async () => {
    const userId = req.user!.id
    const preference = await getAcpPreference(userId, agent)
    if (!preference.enabled) {
      res.json({ job: null, enabled: false })
      return
    }
    const now = Date.now()
    const wasOnline = localAgentRuns.online(userId, now, agent)
    const job = localAgentRuns.poll(userId, parsed.data.deviceId, now, agent, parsed.data.catalog)
    res.json({ job, enabled: true })
    if (!wasOnline) wake(userId)
  })().catch(next)
})

localAgentRouter.post('/acp/:agent/stop', (req, res, next) => {
  const agent = acpAgentParam(req, res)
  if (!agent) return
  localAgentRuns
    .cancel(req.user!.id, agent)
    .then(() => res.json({ ok: true }))
    .catch(next)
})

/** An unguessable, short-lived run token grants only this canvas's resident tools.
 * Recheck membership and bans on every request, independently of browser cookies. */
export async function handleLocalAgentMcp(req: Request, res: Response) {
  const token = req.headers.authorization?.replace(/^Bearer /, '') ?? ''
  const id = req.params.id ?? ''
  const run = localAgentRuns.authorized(id, token)
  const canvas = run && (await store.load(run.request.canvasId))
  if (!run || !canvas || !canEditCanvas(run.userId, canvas) || (await isBanned(run.userId))) {
    res.status(403).json({ error: 'Local run unavailable' })
    return
  }
  if (req.method !== 'POST') {
    res.status(405).end()
    return
  }
  const server = new Server({ name: 'doop', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: run.request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.input_schema,
    })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const result = await localAgentRuns.execute(id, token, params.name, params.arguments ?? {})
    const content: ContentBlock[] = []
    if (typeof result.content === 'string') content.push({ type: 'text', text: result.content })
    else
      for (const block of result.content ?? []) {
        if (block.type === 'text') content.push({ type: 'text', text: block.text })
        else if (block.type === 'image' && block.source.type === 'base64') {
          content.push({ type: 'image', data: block.source.data, mimeType: block.source.media_type })
        }
      }
    return { content, isError: !!result.is_error }
  })
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, req.body)
}
