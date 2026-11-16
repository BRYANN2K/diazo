/**
 * server/speech.ts — the speech backend (proposal 18, ADR 0014).
 *
 * Engines install in one click on the person's Mac or on the `diazo-speech`
 * sidecar (server, admins only); jobs route per the person's preferences and
 * the cloud only ever runs on their own key. Local jobs send nothing to a
 * third party: a desktop job's audio already lives on the instance and only
 * words (or generated audio) come back; a server job stays inside it.
 */

import { nanoid } from 'nanoid'
import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db } from './db/index.ts'
import * as t from './db/schema.ts'
import { env } from './env.ts'
import { store } from './store.ts'
import * as storage from './storage.ts'
import { canEditCanvas } from './access.ts'
import { getAccounts } from './modelAccounts.ts'
import { open, seal } from './secretBox.ts'
import {
  catalogEntry,
  installableEntry,
  INSTALL_STATES,
  type CustomModelInput,
  type SmokeReport,
  type SpeechRequest,
  type StoredCustomModel,
  DEFAULT_PREFERENCES,
  ELEVENLABS_MODELS,
  routeTarget,
  SCRIBE_PRICE_PER_HOUR,
  SPEECH_CATALOG,
  type CustomModel,
  type RouteTarget,
  type SpeechInstall,
  type SpeechJob,
  type SpeechPreferences,
  type SpeechRuntime,
  type Voice,
} from '../shared/speech.ts'
import type { Transcript } from '../shared/motionMedia.ts'
import type { TranscriptWord } from '../shared/motion.ts'

export class SpeechError extends Error {}

export const speechEnabled = () => env.DOOP_SPEECH
export const elevenLabsEnabled = () => env.DOOP_ELEVENLABS
const sidecarUrl = () => env.DOOP_SPEECH_URL
const sidecarToken = () => env.DOOP_SPEECH_TOKEN

/* ---------------------------------------------------------------- */
/* persistence                                                       */
/* ---------------------------------------------------------------- */

export async function listInstalls(): Promise<SpeechInstall[]> {
  const rows = await db.select().from(t.speechInstalls)
  return rows.map((r) => ({
    id: r.id,
    target: 'server',
    modelId: r.modelId,
    engine: r.engine as SpeechInstall['engine'],
    revision: r.revision,
    state: r.state,
    bytes: r.bytes,
    error: r.error ?? undefined,
    installedBy: r.installedBy,
    installedAt: r.installedAt,
    lastUsedAt: r.lastUsedAt ?? undefined,
  }))
}

export async function installedModelIds(): Promise<string[]> {
  return (await listInstalls()).filter((i) => i.state === 'ready').map((i) => i.modelId)
}

export async function saveJob(job: SpeechJob): Promise<void> {
  await db
    .insert(t.speechJobs)
    .values({
      id: job.id,
      kind: job.kind,
      target: job.target,
      deviceId: job.deviceId ?? null,
      modelId: job.modelId,
      inputAssetId: job.inputAssetId ?? null,
      inputText: job.inputText ?? null,
      state: job.state,
      progress: job.progress,
      request: job.request ?? null,
      output: job.output ?? null,
      outputAssetId: job.outputAssetId ?? null,
      requestedBy: job.requestedBy,
      error: job.error ?? null,
      canvasId: job.canvasId ?? null,
      mediaId: job.mediaId ?? null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    })
    .onConflictDoUpdate({
      target: t.speechJobs.id,
      set: {
        state: job.state,
        progress: job.progress,
        output: job.output ?? null,
        outputAssetId: job.outputAssetId ?? null,
        error: job.error ?? null,
        updatedAt: job.updatedAt,
      },
    })
}

function jobRow(r: typeof t.speechJobs.$inferSelect): SpeechJob {
  return {
    id: r.id,
    kind: r.kind,
    target: r.target,
    deviceId: r.deviceId ?? undefined,
    modelId: r.modelId,
    inputAssetId: r.inputAssetId ?? undefined,
    inputText: r.inputText ?? undefined,
    state: r.state,
    progress: r.progress,
    request: r.request ?? undefined,
    output: r.output ?? undefined,
    outputAssetId: r.outputAssetId ?? undefined,
    requestedBy: r.requestedBy,
    error: r.error ?? undefined,
    canvasId: r.canvasId ?? undefined,
    mediaId: r.mediaId ?? undefined,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

export async function getJob(id: string): Promise<SpeechJob | undefined> {
  const rows = await db.select().from(t.speechJobs).where(eq(t.speechJobs.id, id))
  return rows[0] ? jobRow(rows[0]) : undefined
}

export async function getPreferences(userId: string): Promise<SpeechPreferences> {
  const rows = await db.select().from(t.speechPreferences).where(eq(t.speechPreferences.userId, userId))
  return rows[0]?.prefs ?? DEFAULT_PREFERENCES
}

export async function savePreferences(userId: string, prefs: SpeechPreferences): Promise<void> {
  await db
    .insert(t.speechPreferences)
    .values({ userId, prefs, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: t.speechPreferences.userId, set: { prefs, updatedAt: Date.now() } })
}

/** the public shape never carries the sealed download token */
function publicCustomModel(model: StoredCustomModel): CustomModel {
  const { token, ...rest } = model
  return { ...rest, hasToken: Boolean(token) || model.hasToken }
}

export async function listCustomModels(): Promise<CustomModel[]> {
  const rows = await db.select().from(t.speechCustomModels)
  return rows.map((r) => publicCustomModel(r.model as StoredCustomModel))
}

export async function getCustomModel(id: string): Promise<CustomModel | undefined> {
  const [row] = await db.select().from(t.speechCustomModels).where(eq(t.speechCustomModels.id, id))
  return row ? publicCustomModel(row.model as StoredCustomModel) : undefined
}

export async function saveCustomModel(model: StoredCustomModel): Promise<void> {
  await db
    .insert(t.speechCustomModels)
    .values({ id: model.id, model, createdAt: model.createdAt })
    .onConflictDoUpdate({ target: t.speechCustomModels.id, set: { model } })
}

export async function listVoices(ownerId: string): Promise<Voice[]> {
  const rows = await db.select().from(t.voices).where(eq(t.voices.ownerId, ownerId))
  return rows.map((r) => r.voice)
}

/* ---------------------------------------------------------------- */
/* routing (18.12)                                                    */
/* ---------------------------------------------------------------- */

/** desktops currently polling, with what each reports installed — the relay
 *  refreshes this map; `auto` reads it */
const desktops = new Map<string, { models: string[]; at: number; userId: string }>()
const DESKTOP_ONLINE_MS = 30_000

export function reportDesktop(deviceId: string, userId: string, models: string[]): void {
  for (const [key, value] of desktops) if (Date.now() - value.at >= DESKTOP_ONLINE_MS) desktops.delete(key)
  const key = `${userId}/${deviceId}`
  if (!desktops.has(key) && desktops.size >= 1000) throw new SpeechError('too many online speech devices')
  desktops.set(key, { models, at: Date.now(), userId })
}

export async function routeFor(
  userId: string,
  kind: 'asr' | 'tts',
  want?: RouteTarget,
  modelId?: string,
): Promise<import('../shared/speech.ts').RouteAnswer> {
  const prefs = await getPreferences(userId)
  const chosen = want ?? (kind === 'asr' ? prefs.transcribeTarget : prefs.voiceTarget)
  const requested = modelId ?? prefs.modelId
  if (requested) {
    const custom = (await listCustomModels()).find(
      (m) => m.id === requested && (m.owner === userId || m.owner === 'instance'),
    )
    if (custom && !custom.enabled)
      return {
        target: 'install',
        modelId: requested,
        reason: 'custom model stays disabled until its smoke test passes',
      }
  }
  const serverInstalled = await installedModelIds()
  const desktopOnline = [...desktops.values()].some((d) => d.userId === userId && Date.now() - d.at < DESKTOP_ONLINE_MS)
  const desktopInstalled = [
    ...new Set(
      [...desktops.values()]
        .filter((d) => d.userId === userId && Date.now() - d.at < DESKTOP_ONLINE_MS)
        .flatMap((d) => d.models),
    ),
  ]
  return routeTarget(
    chosen,
    kind,
    { desktop: desktopOnline, server: Boolean(sidecarUrl() && sidecarToken()) },
    { desktop: desktopInstalled, server: serverInstalled },
    requested,
  )
}

/* ---------------------------------------------------------------- */
/* jobs (18.13)                                                       */
/* ---------------------------------------------------------------- */

export async function createJob(
  requestedBy: string,
  input: {
    kind: 'transcribe' | 'speak'
    target: SpeechJob['target']
    request?: SpeechRequest
    modelId: string
    inputAssetId?: string
    inputText?: string
    canvasId?: string
    mediaId?: string
    deviceId?: string
  },
): Promise<SpeechJob> {
  const now = Date.now()
  const job: SpeechJob = {
    id: nanoid(12),
    kind: input.kind,
    target: input.target,
    deviceId: input.deviceId,
    request: input.request,
    modelId: input.modelId,
    inputAssetId: input.inputAssetId,
    inputText: input.inputText,
    state: 'queued',
    progress: 0,
    requestedBy,
    canvasId: input.canvasId,
    mediaId: input.mediaId,
    createdAt: now,
    updatedAt: now,
  }
  await saveJob(job)
  return job
}

/** the shell reports custom-model smoke test outcomes with its poll (18.9):
 *  only the owner's desktop-target rows may be updated */
async function recordSmokeReports(userId: string, reports: SmokeReport[]): Promise<void> {
  for (const report of reports) {
    const [row] = await db.select().from(t.speechCustomModels).where(eq(t.speechCustomModels.id, report.modelId))
    if (!row) continue
    const model = row.model as StoredCustomModel
    if (model.owner !== userId || model.target !== 'desktop') continue
    await saveCustomModel({
      ...model,
      smokeTest: { ok: report.ok, log: report.log, tookMs: report.tookMs, at: Date.now() },
      enabled: report.ok,
    })
  }
}

/** the desktop relay: a shell polls for its queued jobs, then finishes them */
export async function pollDesktopJobs(
  deviceId: string,
  userId: string,
  models: string[],
  smoke?: SmokeReport[],
): Promise<SpeechJob[]> {
  reportDesktop(deviceId, userId, models)
  if (smoke?.length) await recordSmokeReports(userId, smoke)
  // Atomic compare-and-set: two polling devices cannot receive the same job.
  const rows = await db
    .select()
    .from(t.speechJobs)
    .where(
      and(eq(t.speechJobs.target, 'desktop'), eq(t.speechJobs.state, 'queued'), eq(t.speechJobs.requestedBy, userId)),
    )
  const claimed: SpeechJob[] = []
  for (const row of rows) {
    const canvas = row.canvasId ? store.getCanvas(row.canvasId) : undefined
    if (
      !canvas ||
      !canEditCanvas(userId, canvas) ||
      (row.deviceId && row.deviceId !== deviceId) ||
      !models.includes(row.modelId)
    )
      continue
    const updated = await db
      .update(t.speechJobs)
      .set({ deviceId, state: 'running', updatedAt: Date.now() })
      .where(and(eq(t.speechJobs.id, row.id), eq(t.speechJobs.state, 'queued')))
      .returning()
    if (updated[0]) claimed.push(jobRow(updated[0]))
  }
  return claimed
}

/** A terminal job cannot be revived. The owner and claiming device are
 * mandatory for the desktop relay; workers use the same compare-and-set. */
export async function finishJob(
  id: string,
  patch: { state: SpeechJob['state']; progress?: number; output?: unknown; outputAssetId?: string; error?: string },
  ownerId: string,
  deviceId?: string,
): Promise<SpeechJob | undefined> {
  const job = await getJob(id)
  if (
    !job ||
    job.requestedBy !== ownerId ||
    (deviceId !== undefined && (job.target !== 'desktop' || job.deviceId !== deviceId))
  )
    return undefined
  if (job.state !== 'running' && !(job.state === 'queued' && patch.state === 'canceled'))
    throw new SpeechError('job is not running')
  if (!['done', 'failed', 'canceled', 'running'].includes(patch.state)) throw new SpeechError('invalid job transition')
  if (
    patch.progress !== undefined &&
    (!Number.isFinite(patch.progress) || patch.progress < job.progress || patch.progress > 1)
  )
    throw new SpeechError('progress must increase within 0..1')
  const updated = await db
    .update(t.speechJobs)
    .set({
      ...patch,
      progress: patch.state === 'done' ? 1 : (patch.progress ?? job.progress),
      updatedAt: Date.now(),
    })
    .where(and(eq(t.speechJobs.id, id), eq(t.speechJobs.state, job.state)))
    .returning()
  return updated[0] ? jobRow(updated[0]) : undefined
}

/* ---------------------------------------------------------------- */
/* the sidecar (18.11): internal only, bearer from doop-secrets        */
/* ---------------------------------------------------------------- */

export async function sidecar(path: string, init: RequestInit): Promise<Record<string, unknown>> {
  const url = sidecarUrl()
  if (!speechEnabled() || !url || !sidecarToken())
    throw new SpeechError('not available on this instance — set DOOP_SPEECH_URL and DOOP_SPEECH_TOKEN')
  const res = await fetch(`${url}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${sidecarToken()}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
  })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new SpeechError(String(body.error ?? `sidecar HTTP ${res.status}`))
  return body
}

/** an admin's one click: ask the sidecar to download, verify and warm up */
export async function installOnServer(modelId: string, installedBy: string): Promise<SpeechInstall> {
  const entry = catalogEntry(modelId)
  if (!entry) throw new SpeechError(`no catalog model ${modelId}`)
  if (!entry.targets.includes('server')) throw new SpeechError(`${entry.label} does not install on the server`)
  if (!installableEntry(entry)) throw new SpeechError('model release is not pinned and verified yet')
  const now = Date.now()
  const install: SpeechInstall = {
    id: nanoid(10),
    target: 'server',
    modelId,
    engine: entry.runtime,
    revision: entry.source.type === 'hf' ? entry.source.commit : entry.source.release,
    state: 'downloading',
    bytes: entry.files.reduce((n, f) => n + f.bytes, 0),
    installedBy,
    installedAt: now,
  }
  await db.insert(t.speechInstalls).values({
    id: install.id,
    modelId,
    engine: install.engine,
    revision: install.revision,
    state: install.state,
    bytes: install.bytes,
    installedBy,
    installedAt: now,
  })
  try {
    const body = await sidecar('/v1/installs', {
      method: 'POST',
      body: JSON.stringify({ model_id: modelId, source: entry.source, files: entry.files }),
    })
    if (!INSTALL_STATES.includes(body.state as SpeechInstall['state']))
      throw new SpeechError('sidecar returned an invalid install state')
    const state = body.state as SpeechInstall['state']
    await db
      .update(t.speechInstalls)
      .set({ state, error: typeof body.error === 'string' ? body.error : null })
      .where(eq(t.speechInstalls.id, install.id))
    return { ...install, state }
  } catch (error) {
    await db
      .update(t.speechInstalls)
      .set({ state: 'failed', error: 'install failed; check the speech service' })
      .where(eq(t.speechInstalls.id, install.id))
    throw error
  }
}

export async function uninstallOnServer(modelId: string): Promise<void> {
  await sidecar(`/v1/installs/${modelId}`, { method: 'DELETE' })
  await db.delete(t.speechInstalls).where(eq(t.speechInstalls.modelId, modelId))
}

/* ---------------------------------------------------------------- */
/* cloud (18.6, 18.7): the person's own key, cost shown first          */
/* ---------------------------------------------------------------- */

async function keyFor(userId: string, kind: 'elevenlabs-key' | 'openai-key'): Promise<string | undefined> {
  if (!speechEnabled() || (kind === 'elevenlabs-key' && !elevenLabsEnabled()))
    throw new SpeechError('speech provider is disabled')
  const accounts = await getAccounts(userId)
  return accounts.find((a) => a.kind === kind && a.enabled && a.apiKey)?.apiKey
}

const voiceCache = new Map<string, { voices: unknown[]; at: number; credential: string }>()
const VOICE_CACHE_MS = 10 * 60 * 1000

export async function elevenLabsVoices(userId: string, search?: string): Promise<unknown[]> {
  const key = await keyFor(userId, 'elevenlabs-key')
  if (!key) throw new SpeechError('connect an ElevenLabs key in Settings → Diazo Agent → Voice')
  const credential = createHash('sha256').update(key).digest('hex')
  const cached = voiceCache.get(userId)
  if (cached && cached.credential === credential && Date.now() - cached.at < VOICE_CACHE_MS && !search)
    return cached.voices
  const res = await fetch(
    `https://api.elevenlabs.io/v2/voices?page_size=100${search ? `&search=${encodeURIComponent(search)}` : ''}`,
    { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(30_000) },
  )
  if (!res.ok) throw new SpeechError(`ElevenLabs voices failed (${res.status})`)
  const body = (await res.json()) as { voices?: unknown[] }
  if (!search) voiceCache.set(userId, { voices: body.voices ?? [], at: Date.now(), credential })
  return body.voices ?? []
}

/** what a scribe job costs, shown before the run (18.7) */
export function scribeEstimate(seconds: number): number {
  return (seconds / 3600) * SCRIBE_PRICE_PER_HOUR
}

/** ElevenLabs Scribe — word timings + optional speakers, on the person's key */
export async function scribeTranscribe(
  userId: string,
  audio: { buf: Buffer; name: string },
  opts: { language?: string; speakers?: boolean; numSpeakers?: number },
): Promise<Transcript> {
  const key = await keyFor(userId, 'elevenlabs-key')
  if (!key) throw new SpeechError('connect an ElevenLabs key — cloud transcription only runs on your own account')
  if (audio.buf.length === 0 || audio.buf.length > 25 * 1024 * 1024)
    throw new SpeechError('audio must be within 25 MiB')
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(audio.buf)]), audio.name)
  form.append('model_id', 'scribe_v3')
  form.append('timestamps_granularity', 'word')
  if (opts.language) form.append('language_code', opts.language)
  if (opts.speakers) {
    form.append('diarize', 'true')
    if (opts.numSpeakers) form.append('num_speakers', String(opts.numSpeakers))
  }
  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': key },
    body: form,
    signal: AbortSignal.timeout(5 * 60_000),
  })
  if (!res.ok) throw new SpeechError(`Scribe failed (${res.status})`)
  const body = (await res.json()) as {
    language_code?: string
    words?: { text: string; start: number; end: number; speaker_id?: string }[]
  }
  const words: TranscriptWord[] = (body.words ?? [])
    .filter((w) => typeof w.text === 'string' && w.text.trim() && w.end > w.start)
    .map((w) => ({
      text: w.text,
      start: w.start,
      end: w.end,
      ...(w.speaker_id ? { speaker: w.speaker_id.replace('speaker_', 'S') } : {}),
    }))
  return {
    language: body.language_code ?? opts.language ?? 'und',
    words,
    engine: 'elevenlabs',
    model: 'scribe_v3',
    target: 'cloud',
    provider: 'elevenlabs',
  }
}

/** OpenAI whisper-1 — word timings via verbose_json; 25 MB per request (18.7) */
export async function openaiTranscribe(
  userId: string,
  audio: { buf: Buffer; name: string },
  opts: { language?: string },
): Promise<Transcript> {
  const key = await keyFor(userId, 'openai-key')
  if (!key) throw new SpeechError('connect an OpenAI key — cloud transcription only runs on your own account')
  if (audio.buf.length === 0 || audio.buf.length > 25 * 1024 * 1024)
    throw new SpeechError('audio must be within 25 MiB')
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(audio.buf)]), audio.name)
  form.append('model', 'whisper-1')
  form.append('response_format', 'verbose_json')
  form.append('timestamp_granularities[]', 'word')
  if (opts.language) form.append('language', opts.language)
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(5 * 60_000),
  })
  if (!res.ok) throw new SpeechError(`OpenAI transcription failed (${res.status})`)
  const body = (await res.json()) as {
    language?: string
    words?: { word: string; start: number; end: number }[]
  }
  const words: TranscriptWord[] = (body.words ?? [])
    .filter((w) => w.end > w.start)
    .map((w) => ({ text: w.word.trim(), start: w.start, end: w.end }))
    .filter((w) => w.text.length > 0)
  return {
    language: body.language ?? opts.language ?? 'und',
    words,
    engine: 'openai',
    model: 'whisper-1',
    target: 'cloud',
    provider: 'openai',
  }
}

/** ElevenLabs voice-over — audio + character alignment folded into words (18.6) */
export async function elevenLabsSpeak(
  userId: string,
  input: { voiceId: string; model?: string; text: string; previous?: string; next?: string },
): Promise<{ audio: Buffer; transcript: Transcript; cost: number }> {
  const key = await keyFor(userId, 'elevenlabs-key')
  if (!key) throw new SpeechError('connect an ElevenLabs key — voice-over only runs on your own account')
  const model = input.model ?? 'eleven_v4'
  const option = ELEVENLABS_MODELS.find((m) => m.id === model)
  if (!option) throw new SpeechError('unknown voice model')
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(input.voiceId)) throw new SpeechError('invalid voice id')
  if (input.text.length > option.chars)
    throw new SpeechError(`${option.label} takes ${option.chars} characters per request`)
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${input.voiceId}/with-timestamps`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: input.text,
      model_id: model,
      previous_text: input.previous,
      next_text: input.next,
    }),
    signal: AbortSignal.timeout(5 * 60_000),
  })
  if (!res.ok) throw new SpeechError(`ElevenLabs TTS failed (${res.status})`)
  const body = (await res.json()) as {
    audio_base64?: string
    alignment?: {
      characters?: string[]
      character_start_times_seconds?: number[]
      character_end_times_seconds?: number[]
    }
  }
  if (!body.audio_base64) throw new SpeechError('ElevenLabs returned no audio')
  const words = charsToWords(
    body.alignment?.characters ?? [],
    body.alignment?.character_start_times_seconds ?? [],
    body.alignment?.character_end_times_seconds ?? [],
  )
  return {
    audio: Buffer.from(body.audio_base64, 'base64'),
    transcript: { language: 'und', words, engine: 'elevenlabs', model, target: 'cloud', provider: 'elevenlabs' },
    cost: (input.text.length / 1000) * option.per1k,
  }
}

/** fold a character alignment into word timings — spaces break words */
export function charsToWords(chars: string[], starts: number[], ends: number[]): TranscriptWord[] {
  if (
    chars.length !== starts.length ||
    chars.length !== ends.length ||
    starts.some((v, i) => !Number.isFinite(v) || v < 0 || !Number.isFinite(ends[i]) || ends[i]! < v)
  )
    throw new SpeechError('invalid character alignment')
  const words: TranscriptWord[] = []
  let cur = ''
  let start = 0
  const flush = (end: number) => {
    if (!cur.trim()) return
    words.push({ text: cur.trim(), start, end })
    cur = ''
  }
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!
    if (cur === '') start = starts[i] ?? 0
    if (/\s/.test(c)) {
      flush(starts[i] ?? ends[i] ?? 0)
      continue
    }
    cur += c
    if (i === chars.length - 1) flush(ends[i] ?? start)
  }
  flush(ends[ends.length - 1] ?? start)
  return words
}

/* ---------------------------------------------------------------- */
/* custom models (18.9)                                                */
/* ---------------------------------------------------------------- */

const SAFE_EXTS = new Set(['.safetensors', '.onnx', '.gguf', '.bin.ggml', '.onnx_data'])

/** which runtimes load which kind (18.9) — anything outside is refused */
const KIND_RUNTIMES: Record<CustomModel['kind'], readonly SpeechRuntime[]> = {
  asr: ['sherpa-onnx', 'whisper.cpp', 'mlx-audio'],
  tts: ['sherpa-onnx', 'mlx-audio', 'pocket-tts'],
  speakers: ['sherpa-onnx', 'pyannote'],
}

export function validateCustomModel(input: {
  kind: CustomModel['kind']
  runtime: string
  source: unknown
  files: unknown
  licenseId?: string
  licenseText?: string
  licenseAck?: boolean
}): string | null {
  const runtimes: readonly string[] = ['sherpa-onnx', 'whisper.cpp', 'mlx-audio', 'pocket-tts', 'pyannote']
  if (!runtimes.includes(input.runtime)) return `runtime must be one of ${runtimes.join(', ')}`
  const src = input.source as { type?: string; repo?: string; commit?: string } | undefined
  if (!['asr', 'tts', 'speakers'].includes(input.kind)) return 'unknown speech kind'
  if (!KIND_RUNTIMES[input.kind].includes(input.runtime as SpeechRuntime))
    return `${input.runtime} does not run ${input.kind}`
  if (src?.type === 'hf') {
    if (typeof src.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(src.repo)) return 'source.repo must be owner/name'
    if (typeof src.commit !== 'string' || !/^[0-9a-f]{40}$/.test(src.commit))
      return 'source.commit must be a pinned commit hash'
  } else if (src?.type !== 'local') return 'source must be a Hugging Face repo or local files'
  if (!Array.isArray(input.files) || input.files.length === 0 || input.files.length > 100)
    return 'files must name each model file'
  for (const f of input.files as { path?: unknown; bytes?: unknown; sha256?: unknown }[]) {
    if (
      !f ||
      typeof f.path !== 'string' ||
      f.path.length > 200 ||
      !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(f.path) ||
      f.path.split('/').some((part) => part === '.' || part === '..')
    )
      return 'each file needs a safe relative path'
    if (![...SAFE_EXTS].some((ext) => (f.path as string).endsWith(ext))) {
      return `${f.path}: safetensors, ONNX and GGUF only — pickle files are refused`
    }
    if (typeof f.bytes !== 'number' || !Number.isSafeInteger(f.bytes) || f.bytes <= 0 || f.bytes > 20 * 1024 ** 3)
      return 'each file needs its size'
    if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) return 'each file needs its SHA-256'
  }
  if (input.licenseId && input.licenseId.length > 200) return 'licence id is too long'
  if (input.licenseText && input.licenseText.length > 20_000) return 'licence text is too long'
  if (!input.licenseAck) return 'tick "I have read the licence and my use complies"'
  if (!input.licenseId && !input.licenseText) return 'name the licence the repository declares'
  return null
}

/** the sealed download token, opened for a sidecar call only — the route
 *  layer never sees plaintext */
async function customModelToken(id: string): Promise<string | undefined> {
  const [row] = await db.select().from(t.speechCustomModels).where(eq(t.speechCustomModels.id, id))
  const token = (row?.model as StoredCustomModel | undefined)?.token
  return token ? open(token) : undefined
}

/** GET …/custom-models/:id/token: the person's own HF token hands back only
 *  for a desktop-target row they own — the shell needs it to download a
 *  gated repo. A server ('instance') token never leaves the backend. */
export async function customModelTokenFor(id: string, userId: string): Promise<string | undefined> {
  const [row] = await db.select().from(t.speechCustomModels).where(eq(t.speechCustomModels.id, id))
  const model = row?.model as StoredCustomModel | undefined
  if (!model || model.target !== 'desktop' || model.owner !== userId || !model.token) return undefined
  return open(model.token)
}

/** a server-target add is also the install click (18.9): the sidecar
 *  downloads, verifies and warms up; the row tracks it like a catalog one */
async function installCustomOnServer(model: CustomModel, installedBy: string): Promise<void> {
  await db.insert(t.speechInstalls).values({
    id: nanoid(10),
    modelId: model.id,
    engine: model.runtime,
    revision: model.source.type === 'hf' ? model.source.commit : 'local',
    state: 'downloading',
    bytes: model.files.reduce((n, f) => n + f.bytes, 0),
    installedBy,
    installedAt: Date.now(),
  })
  try {
    const token = await customModelToken(model.id)
    const body = await sidecar('/v1/installs', {
      method: 'POST',
      body: JSON.stringify({
        model_id: model.id,
        runtime: model.runtime,
        source: model.source,
        files: model.files,
        ...(token ? { hf_token: token } : {}),
      }),
    })
    if (!INSTALL_STATES.includes(body.state as SpeechInstall['state']))
      throw new SpeechError('sidecar returned an invalid install state')
    await db
      .update(t.speechInstalls)
      .set({ state: body.state as SpeechInstall['state'], error: typeof body.error === 'string' ? body.error : null })
      .where(eq(t.speechInstalls.modelId, model.id))
  } catch (error) {
    await db
      .update(t.speechInstalls)
      .set({ state: 'failed', error: 'install failed; check the speech service' })
      .where(eq(t.speechInstalls.modelId, model.id))
    throw error
  }
}

/** register a model the person adds (18.9): pinned commit, per-file size +
 *  SHA-256, licence acknowledged, disabled until its smoke test passes. The
 *  server target is admin-only, enforced by the route. */
export async function addCustomModel(userId: string, input: CustomModelInput): Promise<CustomModel> {
  if (input.target === 'server' && input.source.type === 'local')
    throw new SpeechError('local files install on the desktop only')
  if (input.target === 'server' && input.runtime === 'mlx-audio')
    throw new SpeechError('mlx-audio runs on Apple silicon — the desktop only')
  const invalid = validateCustomModel(input)
  if (invalid) throw new SpeechError(invalid)
  const now = Date.now()
  const model: StoredCustomModel = {
    id: nanoid(10),
    owner: input.target === 'server' ? 'instance' : userId,
    target: input.target,
    kind: input.kind,
    runtime: input.runtime,
    source:
      input.source.type === 'hf'
        ? { type: 'hf', repo: input.source.repo, commit: input.source.commit }
        : { type: 'local' },
    files: input.files.map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 })),
    licenseId: input.licenseId,
    licenseText: input.licenseText,
    licenseAckBy: userId,
    licenseAckAt: now,
    hasToken: Boolean(input.token),
    token: input.token ? seal(input.token) : undefined,
    enabled: false,
    createdAt: now,
  }
  await saveCustomModel(model)
  if (model.target === 'server') await installCustomOnServer(model, userId)
  return publicCustomModel(model)
}

/** the smoke test gate (18.9): server models ask the sidecar; desktop models
 *  are tested by the shell after install and report with the next poll */
export async function testCustomModel(id: string, userId: string, admin: boolean): Promise<CustomModel> {
  const [row] = await db.select().from(t.speechCustomModels).where(eq(t.speechCustomModels.id, id))
  if (!row) throw new SpeechError('no such custom model')
  const model = row.model as StoredCustomModel
  if (model.owner === 'instance' ? !admin : model.owner !== userId) throw new SpeechError('no such custom model')
  if (model.target === 'desktop')
    throw new SpeechError('the desktop runs its own smoke test after install and reports it with the next poll')
  const started = Date.now()
  const token = model.token ? open(model.token) : undefined
  const body = await sidecar('/v1/test', {
    method: 'POST',
    body: JSON.stringify({
      model_id: model.id,
      kind: model.kind,
      runtime: model.runtime,
      source: model.source,
      files: model.files,
      ...(token ? { hf_token: token } : {}),
    }),
  })
  const tookMs =
    typeof body.took_ms === 'number' && Number.isFinite(body.took_ms) && body.took_ms >= 0
      ? Math.min(body.took_ms, 3_600_000)
      : Date.now() - started
  const next: StoredCustomModel = {
    ...model,
    smokeTest: {
      ok: body.ok === true,
      log: typeof body.log === 'string' ? body.log.slice(0, 4000) : '',
      tookMs,
      at: Date.now(),
    },
    enabled: body.ok === true,
  }
  await saveCustomModel(next)
  return publicCustomModel(next)
}

export async function deleteCustomModel(id: string, userId: string, admin: boolean): Promise<boolean> {
  const [row] = await db.select().from(t.speechCustomModels).where(eq(t.speechCustomModels.id, id))
  if (!row) return false
  const model = row.model as StoredCustomModel
  if (model.owner === 'instance' ? !admin : model.owner !== userId) return false
  if (model.target === 'server') {
    await sidecar(`/v1/installs/${model.id}`, { method: 'DELETE' })
    await db.delete(t.speechInstalls).where(eq(t.speechInstalls.modelId, model.id))
  }
  await db.delete(t.speechCustomModels).where(eq(t.speechCustomModels.id, id))
  return true
}

/* ---------------------------------------------------------------- */
/* cloned voices (18.14): consent recorded, the sample stays private   */
/* ---------------------------------------------------------------- */

export async function addVoice(
  userId: string,
  input: { name: string; sampleAssetId: string; sampleTranscript?: string; engines?: SpeechRuntime[] },
): Promise<Voice> {
  const [asset] = await db
    .select()
    .from(t.assets)
    .where(and(eq(t.assets.id, input.sampleAssetId), eq(t.assets.ownerId, userId)))
  if (!asset || asset.canvasId || !asset.mime.startsWith('audio/'))
    throw new SpeechError('the sample must be one of your uploaded audio files')
  const voice: Voice = {
    id: nanoid(10),
    ownerId: userId,
    name: input.name,
    sampleAssetId: input.sampleAssetId,
    sampleTranscript: input.sampleTranscript,
    consentAt: Date.now(),
    engines: input.engines?.length ? input.engines : ['mlx-audio', 'pocket-tts', 'sherpa-onnx'],
    createdAt: Date.now(),
  }
  await db.insert(t.voices).values({ id: voice.id, ownerId: userId, voice, createdAt: voice.createdAt })
  return voice
}

/** deleting a voice removes its private sample with it */
export async function deleteVoice(id: string, ownerId: string): Promise<boolean> {
  const [row] = await db.select().from(t.voices).where(eq(t.voices.id, id))
  if (!row || row.ownerId !== ownerId) return false
  await db.delete(t.voices).where(eq(t.voices.id, id))
  const [asset] = await db.select().from(t.assets).where(eq(t.assets.id, row.voice.sampleAssetId))
  if (asset && asset.ownerId === ownerId && !asset.canvasId) {
    await db.delete(t.assets).where(eq(t.assets.id, asset.id))
    await storage.deleteObject(`${asset.id}.${asset.ext}`).catch(() => {})
  }
  return true
}

/* ---------------------------------------------------------------- */
/* the catalog view (GET /api/speech/catalog)                          */
/* ---------------------------------------------------------------- */

export async function catalog(userId: string): Promise<unknown> {
  const installs = await listInstalls()
  const desktop = [...desktops.entries()]
    .filter(([, d]) => d.userId === userId && Date.now() - d.at < DESKTOP_ONLINE_MS)
    .map(([key, d]) => ({ deviceId: key.slice(userId.length + 1), models: d.models, online: true }))
  return {
    models: SPEECH_CATALOG,
    installs: { server: installs, desktop: desktop },
    custom: (await listCustomModels()).filter((m) => m.owner === userId || m.owner === 'instance'),
    sidecar: sidecarUrl() !== undefined,
    elevenlabs: elevenLabsEnabled(),
    prices: { scribePerHour: SCRIBE_PRICE_PER_HOUR, elevenlabs: ELEVENLABS_MODELS },
  }
}

/** the runtimes a custom model's files must be loadable by — exported for the desktop catalog */
export type { SpeechRuntime }
export { catalogEntry }
