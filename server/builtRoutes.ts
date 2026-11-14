import type express from 'express'
import { parseBuiltPayload, routeUrl, type BuiltDelivery } from '../shared/built.ts'
import { canEditCanvas, hasDurableCanvasAccess } from './access.ts'
import * as actions from './actions.ts'
import { getUserName, isBanned } from './auth.ts'
import { enqueue, getHook, newDelivery, runDelivery, saveDelivery, signatureProblem } from './built.ts'
import { store } from './store.ts'

/* The preview deploy's end of the Built page (server/built.ts). The route is
   mounted ahead of the JSON parser and the session gate: the signature over
   the raw body is the whole credential, so the bytes must reach it intact.
   Captures take a browser per route, so the delivery is accepted (202) and
   runs in the background; its report lands on the hook (settings card). */

/** Deliveries a canvas may receive per minute — each one is up to
 *  BUILT_MAX_ROUTES full-page captures. */
export const BUILT_DELIVERIES_PER_MIN = 6
/** The body limit for the raw parser in front of the route: 20 routes with
 *  their frame names fit many times over. */
export const BUILT_BODY_LIMIT = '64kb'

const hits = new Map<string, number[]>()

function takeSlot(canvasId: string, now: number): boolean {
  const recent = (hits.get(canvasId) ?? []).filter((t) => now - t < 60_000)
  if (recent.length >= BUILT_DELIVERIES_PER_MIN) {
    hits.set(canvasId, recent)
    return false
  }
  recent.push(now)
  hits.set(canvasId, recent)
  return true
}

export async function handleBuiltDelivery(req: express.Request, res: express.Response): Promise<void> {
  const canvasId = String(req.params.id ?? '')
  const hook = await getHook(canvasId)
  if (!hook) {
    res.status(404).json({ error: 'this canvas has no deploy hook' })
    return
  }
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
  const problem = signatureProblem(
    hook.secret,
    { timestamp: req.get('x-doop-timestamp'), signature: req.get('x-doop-signature') },
    body,
  )
  if (problem) {
    res.status(401).json({ error: problem })
    return
  }
  const now = Date.now()
  if (!takeSlot(canvasId, now)) {
    res.status(429).json({ error: `rate limited — at most ${BUILT_DELIVERIES_PER_MIN} deliveries a minute` })
    return
  }
  let json: unknown
  try {
    json = JSON.parse(body.toString('utf8'))
  } catch {
    res.status(400).json({ error: 'the body must be JSON' })
    return
  }
  const parsed = parseBuiltPayload(json)
  if (!parsed.ok) {
    res.status(parsed.status).json({ error: parsed.error })
    return
  }
  /* the hook writes as the person who created it: it stops the moment they
     lose edit access to the canvas, or their account is suspended */
  const canvas = await store.load(canvasId)
  if (!canvas) {
    res.status(404).json({ error: 'not found' })
    return
  }
  const owner = hook.createdBy
  if (!hasDurableCanvasAccess(owner, canvas) || !canEditCanvas(owner, canvas) || (await isBanned(owner))) {
    res.status(403).json({ error: 'the account that created this hook can no longer edit the canvas' })
    return
  }

  const delivery = newDelivery(parsed.payload, now)
  await saveDelivery(canvasId, { lastDelivery: delivery })
  res.status(202).json({ delivery })

  const payload = parsed.payload
  void enqueue(canvasId, () =>
    store.withCanvas(canvasId, async (loaded) => {
      /* read the hook again: a delivery queued behind another must see the
         frames that one placed, and a hook deleted meanwhile stops here */
      const fresh = await getHook(canvasId)
      if (!loaded || !fresh) return
      const actor = actions.resolveActor({ name: 'Preview deploy', kind: 'user', owner: await getUserName(owner) })
      try {
        const outcome = await runDelivery({
          canvasId,
          delivery,
          payload,
          state: { captures: fresh.captures ?? {}, mappings: fresh.mappings ?? {}, builtPageId: fresh.builtPageId },
          actor,
          ownerId: owner,
        })
        await saveDelivery(canvasId, {
          captures: outcome.captures,
          builtPageId: outcome.builtPageId,
          lastDelivery: outcome.delivery,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await saveDelivery(canvasId, { lastDelivery: failedDelivery(delivery, payload.routes, message) })
      }
    }),
  ).catch((err: unknown) => console.error('[built] delivery failed', err))
}

function failedDelivery(delivery: BuiltDelivery, routes: { path: string }[], error: string): BuiltDelivery {
  return {
    ...delivery,
    status: 'done',
    routes: routes.map(({ path }) => {
      let url = delivery.deployUrl
      try {
        url = routeUrl(delivery.deployUrl, path).href
      } catch {
        /* the report keeps the deploy URL */
      }
      return { route: path, url, status: 'failed', error: error.slice(0, 300) }
    }),
  }
}
