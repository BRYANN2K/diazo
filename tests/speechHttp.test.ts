import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

let server: Server
let owner: Client
let other: Client
let canvasId: string
let pageId: string
let mediaId: string
const model = 'parakeet-tdt-0.6b-v3'
const transcript = {
  language: 'fr',
  words: [
    { text: 'Bonjour', start: 0, end: 0.5, speaker: 'S1' },
    { text: 'Oui', start: 0.6, end: 1, speaker: 'S2' },
  ],
}
const jobBody = () => ({ canvas_id: canvasId, kind: 'transcribe', target: 'desktop', media_id: mediaId })

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
  await owner.post('/api/speech/desktop/poll', { deviceId: 'mac', models: [model] })
}, 70_000)
afterAll(() => server?.stop())

describe('speech REST and persistence', () => {
  it('round-trips preferences and blocks invalid values and non-admin installs', async () => {
    expect((await owner.get('/api/speech/catalog')).status).toBe(200)
    expect((await other.post(`/api/speech/server/installs/${model}`, {})).status).toBe(403)
    expect((await owner.post(`/api/speech/server/installs/${model}`, {})).status).toBe(400)
    const prefs = { transcribeTarget: 'desktop', voiceTarget: 'auto', speakers: true, language: 'fr' }
    expect((await owner.put('/api/speech/preferences', prefs)).status).toBe(200)
    expect(await (await owner.get('/api/speech/preferences')).json()).toEqual(prefs)
    expect((await other.get('/api/speech/preferences')).status).toBe(200)
    expect((await owner.put('/api/speech/preferences', { ...prefs, transcribeTarget: 'shell' })).status).toBe(400)
  })
  it('connects a voice key without exposing it or adding a task runner', async () => {
    const key = 'sk_private_voice_test_00000000000'
    const connected = await owner.post('/api/model-account/elevenlabs-key', { apiKey: key })
    expect(connected.status).toBe(200)
    const view = await connected.json()
    expect(view.accounts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'elevenlabs-key' })]))
    expect(JSON.stringify(view)).not.toContain(key)
    const runners = await (await owner.get('/api/agent-runners')).json()
    expect(runners.runners.some((runner: { provider: string }) => runner.provider === 'elevenlabs-key')).toBe(false)
    expect(runners.default).not.toBe('elevenlabs-key')
  })
  it('requires edit access and cloud cost acknowledgement before creating a job', async () => {
    expect((await other.post('/api/speech/jobs', jobBody())).status).toBe(403)
    const cloud = { ...jobBody(), target: 'cloud', provider: 'openai', speakers: false, seconds: 60 }
    const quote = await owner.post('/api/speech/estimate', {
      kind: 'transcribe',
      target: 'cloud',
      provider: 'openai',
      seconds: 60,
    })
    expect((await quote.json()).usd).toBeCloseTo(0.006)
    expect((await owner.post('/api/speech/jobs', cloud)).status).toBe(400)
    expect((await owner.post('/api/speech/jobs', { ...jobBody(), media_id: 'foreign' })).status).toBe(400)
  })
  it('claims only the owner’s jobs once, validates results and persists words onto the media', async () => {
    const submitted = await owner.post('/api/speech/jobs', jobBody())
    expect(submitted.status).toBe(201)
    const job = (await submitted.json()).job
    expect((await owner.post('/api/speech/jobs', jobBody())).status).toBe(400)
    expect((await other.get(`/api/speech/jobs/${job.id}`)).status).toBe(404)
    expect(
      (await (await other.post('/api/speech/desktop/poll', { deviceId: 'stranger', models: [model] })).json()).jobs,
    ).toEqual([])
    const polls = await Promise.all(
      ['mac', 'mac-two'].map((deviceId) => owner.post('/api/speech/desktop/poll', { deviceId, models: [model] })),
    )
    const claims = await Promise.all(polls.map(async (response) => (await response.json()).jobs))
    const claimed = claims.flat()
    expect(claimed.filter((item) => item.id === job.id)).toHaveLength(1)
    const deviceId = claimed[0].deviceId
    expect(
      (await other.post(`/api/speech/desktop/finish/${job.id}`, { deviceId, state: 'done', transcript })).status,
    ).toBe(404)
    expect(
      (await owner.post(`/api/speech/desktop/finish/${job.id}`, { deviceId: 'foreign', state: 'done', transcript }))
        .status,
    ).toBe(404)
    expect(
      (
        await owner.post(`/api/speech/desktop/finish/${job.id}`, {
          deviceId,
          state: 'done',
          transcript: { language: 'fr', words: [{ text: 'bad', start: 2, end: 1 }] },
        })
      ).status,
    ).toBe(400)
    const done = await owner.post(`/api/speech/desktop/finish/${job.id}`, { deviceId, state: 'done', transcript })
    expect(done.status).toBe(200)
    expect((await done.json()).job).toMatchObject({
      state: 'done',
      progress: 1,
      output: { jobId: job.id, target: 'desktop' },
    })
    const media = (await (await owner.get(`/api/canvases/${canvasId}/pages/${pageId}/media`)).json()).media.find(
      (row: { id: string }) => row.id === mediaId,
    )
    expect(media.transcript.words).toEqual(transcript.words)
    expect(
      (await owner.post(`/api/speech/desktop/finish/${job.id}`, { deviceId, state: 'done', transcript })).status,
    ).toBe(409)
  })
  it('stores desktop voice audio and inserts the clip with its recipe and timed words', async () => {
    await owner.post('/api/speech/desktop/poll', { deviceId: 'voice-mac', models: ['voxcpm2-8bit'] })
    const submitted = await owner.post('/api/speech/jobs', {
      canvas_id: canvasId,
      kind: 'speak',
      target: 'desktop',
      page_id: pageId,
      text: 'Bonjour Oui',
      voice: 'local-voice',
      at: 2,
    })
    expect(submitted.status).toBe(201)
    const job = (await submitted.json()).job
    const claimed = (
      await (await owner.post('/api/speech/desktop/poll', { deviceId: 'voice-mac', models: ['voxcpm2-8bit'] })).json()
    ).jobs
    expect(claimed.map((item: { id: string }) => item.id)).toContain(job.id)
    const audio = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(32)])
    const wrong = await other.req(`/api/speech/desktop/audio/${job.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'x-speech-device': 'voice-mac' },
      body: audio,
    })
    expect(wrong.status).toBe(404)
    const uploaded = await owner.req(`/api/speech/desktop/audio/${job.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'x-speech-device': 'voice-mac' },
      body: audio,
    })
    expect(uploaded.status).toBe(200)
    const asset = (await uploaded.json()).asset
    const done = await owner.post(`/api/speech/desktop/finish/${job.id}`, {
      deviceId: 'voice-mac',
      state: 'done',
      transcript,
      outputAssetId: asset.id,
    })
    expect(done.status).toBe(200)
    expect((await done.json()).job.state).toBe('done')
    const media = (await (await owner.get(`/api/canvases/${canvasId}/pages/${pageId}/media`)).json()).media.find(
      (row: { assetId: string }) => row.assetId === asset.id,
    )
    expect(media).toMatchObject({
      kind: 'audio',
      generation: { text: 'Bonjour Oui', voice: 'local-voice', model: 'voxcpm2-8bit' },
      transcript: { words: transcript.words },
    })
    const comp = (await (await owner.get(`/api/canvases/${canvasId}/pages/${pageId}/composition`)).json()).composition
    expect(comp.tracks.find((track: { kind: string }) => track.kind === 'audio').clips).toEqual([
      expect.objectContaining({ start: 2, duration: 1, source: { type: 'asset', assetId: asset.id } }),
    ])
  })
  it('exposes the same speech jobs through MCP without giving another account access', async () => {
    const key = (await (await owner.post('/api/agent-keys', { name: 'speech' })).json()).secret
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await fetch(`${server.base}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: { canvas_id: canvasId, agent_name: 'Speech', ...args } },
        }),
      })
      expect(response.status).toBe(200)
      return (await response.json()).result
    }
    const list = await call('list_speech_engines', {})
    expect(list.isError).not.toBe(true)
    expect(JSON.parse(list.content[0].text).models.length).toBeGreaterThan(0)
    const result = await call('get_transcript', { media_id: mediaId })
    expect(JSON.parse(result.content[0].text).transcript.words).toEqual(transcript.words)
    const denied = await call('transcribe_clip', {
      media_id: mediaId,
      target: 'cloud',
      provider: 'openai',
      speakers: false,
      seconds: 60,
    })
    expect(denied.isError).toBe(true)
    expect(denied.content[0].text).toContain('max_cost')
  })
  it('keeps cancellation terminal and fails interrupted jobs after restart', async () => {
    const pending = (await (await owner.post('/api/speech/jobs', jobBody())).json()).job
    expect((await other.delete(`/api/speech/jobs/${pending.id}`)).status).toBe(404)
    expect((await (await owner.delete(`/api/speech/jobs/${pending.id}`)).json()).job.state).toBe('canceled')
    const interrupted = (await (await owner.post('/api/speech/jobs', jobBody())).json()).job
    const dir = server.dataDir
    server.stop({ keepData: true })
    await server.stopped
    server = await startServer({ ADMIN_EMAILS: 'speech-owner@test.dev' }, dir)
    expect((await (await owner.get(`/api/speech/jobs/${interrupted.id}`)).json()).job.state).toBe('failed')
    expect((await (await owner.get(`/api/speech/jobs/${pending.id}`)).json()).job.state).toBe('canceled')
    expect((await (await owner.get('/api/speech/preferences')).json()).language).toBe('fr')
  }, 30_000)
})
