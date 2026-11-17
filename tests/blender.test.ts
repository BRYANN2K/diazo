import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

let server: Server
let owner: Client
let other: Client
let canvasId: string

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('blender-owner@test.dev', 'Blender Owner')
  other = await new Client(server).signUp('blender-other@test.dev', 'Other')
  const canvas = await (await owner.post('/api/canvases', { name: 'Blender' })).json()
  canvasId = canvas.id
}, 70_000)
afterAll(() => server?.stop())

describe('blender ops relay', () => {
  it('submits, claims, finishes and scopes ops to the requester', async () => {
    const submitted = await (
      await owner.post('/api/blender/ops', {
        canvasId,
        tool: 'get_scene_info',
      })
    ).json()
    expect(submitted.op.state).toBe('queued')
    expect(submitted.op.klass).toBe('read')

    /* another person never sees the op, and never claims it */
    expect(await (await other.get(`/api/blender/ops/${submitted.op.id}`)).status).toBe(404)
    expect(await (await other.post('/api/blender/poll', { deviceId: 'mac' })).json()).toEqual({ ops: [] })

    const claimed = await (await owner.post('/api/blender/poll', { deviceId: 'mac' })).json()
    expect(claimed.ops).toHaveLength(1)
    expect(claimed.ops[0].state).toBe('running')
    expect(claimed.ops[0].deviceId).toBe('mac')

    /* a different device cannot finish the claim */
    expect(
      await (
        await owner.post(`/api/blender/finish/${submitted.op.id}`, {
          deviceId: 'pc',
          state: 'done',
          result: { objects: 3 },
        })
      ).status,
    ).toBe(404)

    const finished = await (
      await owner.post(`/api/blender/finish/${submitted.op.id}`, {
        deviceId: 'mac',
        state: 'done',
        result: { objects: 3 },
      })
    ).json()
    expect(finished.op.state).toBe('done')
    expect(finished.op.result).toEqual({ objects: 3 })
    expect((await owner.get(`/api/blender/ops/${submitted.op.id}`)).status).toBe(200)
  })

  it('rejects tools outside the relay set and oversized args', async () => {
    expect(
      await (
        await owner.post('/api/blender/ops', { canvasId, tool: 'execute_blender_code', args: {} })
      ).status,
    ).toBe(400)
    expect(
      await (
        await owner.post('/api/blender/ops', {
          canvasId,
          tool: 'add_light',
          args: { blob: 'x'.repeat(70_000) },
        })
      ).status,
    ).toBe(400)
  })

  it('marks write and render tools with their approval class', async () => {
    const write = await (
      await owner.post('/api/blender/ops', { canvasId, tool: 'set_material', args: { object: 'a', material: 'm' } })
    ).json()
    expect(write.op.klass).toBe('write')
    const render = await (
      await owner.post('/api/blender/ops', { canvasId, tool: 'render_frame', args: { engine: 'eevee' } })
    ).json()
    expect(render.op.klass).toBe('render')
    const list = await (await owner.get(`/api/blender/ops?canvasId=${canvasId}`)).json()
    expect(list.ops.length).toBeGreaterThanOrEqual(2)
  })

  it('keeps other canvases out of reach', async () => {
    const otherCanvas = await (await other.post('/api/canvases', { name: 'Not yours' })).json()
    expect(
      await (
        await owner.post('/api/blender/ops', { canvasId: otherCanvas.id, tool: 'get_scene_info' })
      ).status,
    ).toBe(404)
  })
})

describe('blender render jobs', () => {
  it('accepts target blender with an engine and rejects engine elsewhere', async () => {
    const pageId = (await (await owner.get(`/api/canvases/${canvasId}`)).json()).pages[0].id
    const comp = `/api/canvases/${canvasId}/pages/${pageId}/composition`
    await owner.put(comp, { duration: 4, fps: 24, width: 320, height: 240, tracks: [] })
    const job = await (await owner.post(`${comp}/renders`, { format: 'pngseq', target: 'blender' })).json()
    expect(job.job.target).toBe('blender')
    expect(job.job.engine).toBe('eevee')
    expect(
      await (
        await owner.post(`${comp}/renders`, { format: 'mp4', target: 'blender', engine: 'vray' })
      ).status,
    ).toBe(400)
    expect(
      await (
        await owner.post(`${comp}/renders`, { format: 'mp4', target: 'browser', engine: 'eevee' })
      ).status,
    ).toBe(400)
    expect(await (await owner.post(`${comp}/renders`, { format: 'mp4', target: 'server' })).status).toBe(400)
  })
})
