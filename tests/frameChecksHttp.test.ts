import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rendererAvailable } from '../server/screenshot.ts'
import { Client, startServer, type Server } from './harness.ts'

/* POST /api/frames/:id/checks end to end: who may run it, what it answers
   without a renderer, and — where Chromium exists — that the result is
   stored on the frame and reused for an unchanged document. */

let server: Server

beforeAll(async () => {
  server = await startServer()
}, 70_000)

afterAll(() => server?.stop())

describe('frame checks over HTTP', () => {
  let client: Client
  let frameId: string
  let canvasId: string

  beforeAll(async () => {
    client = new Client(server)
    await client.signUp('checks@test.dev', 'Checker')
    canvasId = (await (await client.post('/api/canvases', { name: 'Checks' })).json()).id
    frameId = (
      await (
        await client.post(`/api/canvases/${canvasId}/frames`, {
          name: 'Phone',
          html: '<body style="margin:0"><div style="width:600px">wide</div><button style="width:20px;height:20px">x</button></body>',
        })
      ).json()
    ).id
  })

  async function frame() {
    const canvas = await (await client.get(`/api/canvases/${canvasId}`)).json()
    return canvas.frames.find((f: { id: string }) => f.id === frameId)
  }

  it('refuses a stranger', async () => {
    const stranger = new Client(server)
    await stranger.signUp('checks-stranger@test.dev', 'Stranger')
    const res = await stranger.post(`/api/frames/${frameId}/checks`, {})
    expect(res.status).toBe(403)
  })

  it.skipIf(rendererAvailable())('answers 503 when the server has no renderer', async () => {
    const res = await client.post(`/api/frames/${frameId}/checks`, {})
    expect(res.status).toBe(503)
    expect((await frame()).checks).toBeUndefined()
  })

  it.runIf(rendererAvailable())(
    'checks the frame, stores the result and reuses it for the same html',
    async () => {
      const res = await client.post(`/api/frames/${frameId}/checks`, {})
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.reused).toBe(false)
      expect(body.checks.viewports.map((v: { width: number }) => v.width)).toEqual([375, 768, 1440])
      expect(body.checks.issues.some((i: { ruleId: string }) => i.ruleId === 'FC-OVERFLOW')).toBe(true)
      expect(body.checks.issues.some((i: { ruleId: string }) => i.ruleId === 'FC-TAP')).toBe(true)
      expect((await frame()).checks.htmlHash).toBe(body.checks.htmlHash)
      const again = await (await client.post(`/api/frames/${frameId}/checks`, {})).json()
      expect(again.reused).toBe(true)
    },
    60_000,
  )
})
