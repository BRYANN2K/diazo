import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

let server: Server
let owner: Client
let other: Client
let canvasId: string
let pageId: string
let mediaId: string
const transcript = {
  language: 'fr',
  words: [
    { text: 'Bonjour', start: 0, end: 0.5, speaker: 'S1' },
    { text: 'Oui', start: 0.6, end: 1, speaker: 'S2' },
  ],
}

const customModel = (over: Record<string, unknown> = {}) => ({
  kind: 'asr',
  runtime: 'sherpa-onnx',
  target: 'desktop',
  source: { type: 'hf', repo: 'owner/model', commit: 'a'.repeat(40) },
  files: [{ path: 'model.onnx', bytes: 1000, sha256: 'b'.repeat(64) }],
  licenseId: 'MIT',
  licenseAck: true,
  ...over,
})
const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(32)])

beforeAll(async () => {
  server = await startServer({ ADMIN_EMAILS: 'speech-owner@test.dev' })
  owner = await new Client(server).signUp('speech-owner@test.dev', 'Speech Owner')
  other = await new Client(server).signUp('speech-other@test.dev', 'Other')
  const canvas = await (await owner.post('/api/canvases', { name: 'Speech' })).json()
  canvasId = canvas.id
  pageId = canvas.pages[0].id
  const comp = `/api/canvases/${canvasId}/pages/${pageId}/composition`
  await owner.put(comp, { duration: 6, fps: 30, width: 640, height: 360, tracks: [] })
  const render = await (await owner.post(`${comp}/renders`, { format: 'webm' })).json()
  const upload = await owner.req(`/api/renders/${render.job.id}/upload`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64)]),
  })
  expect(upload.status).toBe(200)
  const asset = (await upload.json()).asset
  const media = await (
    await owner.put(`/api/canvases/${canvasId}/pages/${pageId}/media/${asset.id}`, { kind: 'video' })
  ).json()
  mediaId = media.media.id
  /* give the media a transcript the speaker routes can rename */
  await owner.post('/api/speech/desktop/poll', { deviceId: 'mac', models: ['parakeet-tdt-0.6b-v3'] })
  const submitted = await owner.post('/api/speech/jobs', {
    canvas_id: canvasId,
    kind: 'transcribe',
    target: 'desktop',
    media_id: mediaId,
  })
  const job = (await submitted.json()).job
  await owner.post('/api/speech/desktop/poll', { deviceId: 'mac', models: ['parakeet-tdt-0.6b-v3'] })
  const done = await owner.post(`/api/speech/desktop/finish/${job.id}`, {
    deviceId: 'mac',
    state: 'done',
    transcript,
  })
  expect(done.status).toBe(200)
}, 70_000)
afterAll(() => server?.stop())

describe('custom models (18.9)', () => {
  it('rejects malformed registrations before any download is implied', async () => {
    const bad = [
      customModel({ source: { type: 'hf', repo: 'owner/model', commit: 'main' } }),
      customModel({ runtime: 'pocket-tts' }), // a tts runtime cannot run asr
      customModel({ licenseAck: false }),
      customModel({ licenseId: undefined, licenseText: undefined }),
      customModel({ files: [{ path: 'model.pt', bytes: 1, sha256: 'b'.repeat(64) }] }),
      customModel({ files: [{ path: '../escape.onnx', bytes: 1, sha256: 'b'.repeat(64) }] }),
      customModel({ files: [{ path: 'model.onnx', bytes: 0, sha256: 'b'.repeat(64) }] }),
      customModel({ files: [] }),
      customModel({ surprise: true }),
      customModel({ target: 'server', source: { type: 'local' } }),
    ]
    for (const body of bad) expect((await owner.post('/api/speech/custom-models', body)).status).toBe(400)
    expect((await other.post('/api/speech/custom-models', customModel({ target: 'server' }))).status).toBe(403)
    /* an admin add on the server target reaches for a sidecar this instance
       does not run — it must fail, not pretend an install */
    expect((await owner.post('/api/speech/custom-models', customModel({ target: 'server' }))).status).toBe(400)
  })
  it('registers disabled, seals the token, and lets the owner read it back once', async () => {
    const created = await owner.post('/api/speech/custom-models', customModel({ token: 'hf_secret_test_token_0000' }))
    expect(created.status).toBe(201)
    const model = (await created.json()).model
    expect(model).toMatchObject({ enabled: false, hasToken: true, owner: expect.any(String) })
    expect(JSON.stringify(model)).not.toContain('hf_secret')
    expect(await (await owner.get(`/api/speech/custom-models/${model.id}/token`)).json()).toEqual({
      token: 'hf_secret_test_token_0000',
    })
    expect((await other.get(`/api/speech/custom-models/${model.id}/token`)).status).toBe(404)
    const catalog = await (await owner.get('/api/speech/catalog')).json()
    const row = catalog.custom.find((m: { id: string }) => m.id === model.id)
    expect(JSON.stringify(row)).not.toContain('hf_secret')
    const foreign = await (await other.get('/api/speech/catalog')).json()
    expect(foreign.custom.some((m: { id: string }) => m.id === model.id)).toBe(false)
    expect((await other.delete(`/api/speech/custom-models/${model.id}`)).status).toBe(404)
    expect((await owner.delete(`/api/speech/custom-models/${model.id}`)).status).toBe(200)
    expect((await owner.delete(`/api/speech/custom-models/${model.id}`)).status).toBe(404)
  })
  it('keeps a disabled model out of routing until its own smoke test passes', async () => {
    const model = (await (await owner.post('/api/speech/custom-models', customModel())).json()).model
    const jobBody = { canvas_id: canvasId, kind: 'transcribe', target: 'desktop', media_id: mediaId, model: model.id }
    const refused = await owner.post('/api/speech/jobs', jobBody)
    expect(refused.status).toBe(400)
    expect((await refused.json()).error).toContain('smoke test')
    /* a desktop model is told by the shell, not by POST …/test */
    expect((await owner.post(`/api/speech/custom-models/${model.id}/test`, {})).status).toBe(400)
    /* someone else's poll cannot enable it */
    await other.post('/api/speech/desktop/poll', {
      deviceId: 'stranger',
      models: [],
      smoke: [{ modelId: model.id, ok: true, log: 'fake', tookMs: 1 }],
    })
    expect((await owner.post('/api/speech/jobs', jobBody)).status).toBe(400)
    const poll = await owner.post('/api/speech/desktop/poll', {
      deviceId: 'mac',
      models: [model.id],
      smoke: [{ modelId: model.id, ok: true, log: 'loads and runs', tookMs: 800 }],
    })
    expect(poll.status).toBe(200)
    const catalog = await (await owner.get('/api/speech/catalog')).json()
    expect(catalog.custom.find((m: { id: string }) => m.id === model.id)).toMatchObject({
      enabled: true,
      smokeTest: { ok: true, tookMs: 800 },
    })
    const submitted = await owner.post('/api/speech/jobs', jobBody)
    expect(submitted.status).toBe(201)
    const job = (await submitted.json()).job
    expect(job.modelId).toBe(model.id)
    const claimed = (
      await (await owner.post('/api/speech/desktop/poll', { deviceId: 'mac', models: [model.id] })).json()
    ).jobs
    expect(claimed.map((j: { id: string }) => j.id)).toContain(job.id)
    expect((await owner.delete(`/api/speech/jobs/${job.id}`)).status).toBe(200)
  })
})

describe('speaker names (18.8)', () => {
  it('renames only the speakers the transcript produced, once, as an editor', async () => {
    const url = `/api/speech/media/${mediaId}/speakers`
    expect((await owner.put(url, { canvas_id: canvasId, names: { S9: 'Nobody' } })).status).toBe(400)
    const renamed = await owner.put(url, { canvas_id: canvasId, names: { S1: 'Ana', S2: 'Bo' } })
    expect(renamed.status).toBe(200)
    expect((await renamed.json()).transcript.speakers).toEqual({ S1: 'Ana', S2: 'Bo' })
    const media = (await (await owner.get(`/api/canvases/${canvasId}/pages/${pageId}/media`)).json()).media.find(
      (row: { id: string }) => row.id === mediaId,
    )
    expect(media.transcript.speakers).toEqual({ S1: 'Ana', S2: 'Bo' })
    expect((await other.put(url, { canvas_id: canvasId, names: { S1: 'X' } })).status).toBe(400)
    expect((await owner.put(url, { canvas_id: canvasId, names: { 'not-a-speaker': 'X' } })).status).toBe(400)
  })
})

describe('cloned voices (18.14)', () => {
  it('stores a private consent sample and the voice, never foreign samples', async () => {
    expect((await owner.post('/api/speech/voices', { name: 'Mine', sampleAssetId: 'x', consent: true })).status).toBe(
      400,
    )
    const wrongType = await owner.req('/api/speech/voices/sample', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('not audio'),
    })
    expect(wrongType.status).toBe(400)
    const uploaded = await owner.req('/api/speech/voices/sample', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: wav,
    })
    expect(uploaded.status).toBe(201)
    const sample = (await uploaded.json()).asset
    expect(sample.mime).toBe('audio/wav')
    expect((await owner.post('/api/speech/voices', { name: 'Mine', sampleAssetId: sample.id })).status).toBe(400)
    const created = await owner.post('/api/speech/voices', {
      name: 'Mine',
      sampleAssetId: sample.id,
      sampleTranscript: 'Bonjour, c’est moi.',
      consent: true,
    })
    expect(created.status).toBe(201)
    const voice = (await created.json()).voice
    expect(voice).toMatchObject({ name: 'Mine', sampleAssetId: sample.id, ownerId: expect.any(String) })
    const voices = (await (await owner.get('/api/speech/voices')).json()).voices
    expect(voices.map((v: { id: string }) => v.id)).toEqual([voice.id])
    expect(await (await other.get('/api/speech/voices')).json()).toEqual({ voices: [] })
    expect((await other.delete(`/api/speech/voices/${voice.id}`)).status).toBe(404)
    /* deleting the voice removes its private sample with it */
    expect((await owner.delete(`/api/speech/voices/${voice.id}`)).status).toBe(200)
    expect((await owner.get(`/a/${sample.id}.wav`)).status).toBe(404)
    expect((await (await owner.get('/api/speech/voices')).json()).voices).toEqual([])
  })
})
