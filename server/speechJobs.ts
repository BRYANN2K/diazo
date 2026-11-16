/** Speech jobs share one entry point across REST and canvas tools. */
import { nanoid } from 'nanoid'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from './db/index.ts'
import * as t from './db/schema.ts'
import * as speech from './speech.ts'
import { getAsset, storeAsset } from './assets.ts'
import { store } from './store.ts'
import { canEditCanvas } from './access.ts'
import { canvasPages } from '../shared/pages.ts'
import { parseTranscript, type Transcript } from '../shared/motionMedia.ts'
import { MOTION_LIMITS } from '../shared/motion.ts'
import { ELEVENLABS_MODELS, speechRequestSchema, type SpeechJob, type SpeechRequest } from '../shared/speech.ts'
import { patchComposition, speechProgress, mediaTranscribed } from './actions.ts'

function assertEditor(userId: string, canvasId: string): void {
  const canvas = store.getCanvas(canvasId)
  if (!canvas || !canEditCanvas(userId, canvas)) throw new speech.SpeechError('canvas edit access required')
}

export function estimateSpeech(request: SpeechRequest): { usd: number; estimated: true; basis: string } {
  if (request.target !== 'cloud') return { usd: 0, estimated: true, basis: 'local processing' }
  if (request.kind === 'transcribe') {
    if (!request.seconds) throw new speech.SpeechError('seconds is required for the cloud estimate')
    const perHour = request.provider === 'openai' ? 0.36 : 0.2
    return {
      usd: (request.seconds / 3600) * perHour,
      estimated: true,
      basis: 'declared source duration; provider billing may differ',
    }
  }
  const model = ELEVENLABS_MODELS.find((entry) => entry.id === (request.model ?? 'eleven_v4'))
  if (!model) throw new speech.SpeechError('unknown voice model')
  if (!request.text || request.text.length > model.chars)
    throw new speech.SpeechError(`text must contain 1..${model.chars} characters`)
  return {
    usd: (request.text.length / 1000) * model.per1k,
    estimated: true,
    basis: 'script characters; provider billing may differ',
  }
}

export async function submitSpeech(userId: string, canvasId: string, raw: unknown): Promise<SpeechJob> {
  if (!speech.speechEnabled()) throw new speech.SpeechError('speech is disabled')
  assertEditor(userId, canvasId)
  const parsed = speechRequestSchema.safeParse(raw)
  if (!parsed.success) throw new speech.SpeechError(parsed.error.issues[0]?.message ?? 'invalid speech request')
  const request = parsed.data
  const prefs = await speech.getPreferences(userId)
  const route = await speech.routeFor(
    userId,
    request.kind === 'transcribe' ? 'asr' : 'tts',
    request.target,
    request.model,
  )
  if (route.target === 'install') throw new speech.SpeechError(route.reason)
  // A preference may explicitly select cloud; auto itself never selects it.
  request.target = route.target
  request.language ??= prefs.language
  request.speakers ??= prefs.speakers
  request.provider ??= prefs.cloudProvider ?? 'elevenlabs'
  if (request.kind === 'speak' && request.provider !== 'elevenlabs' && route.target === 'cloud')
    throw new speech.SpeechError('cloud voice-over uses ElevenLabs')
  if (route.target === 'cloud' && request.provider === 'elevenlabs' && !speech.elevenLabsEnabled())
    throw new speech.SpeechError('ElevenLabs is disabled')
  if (route.target === 'cloud' && request.speakers && request.provider === 'openai')
    throw new speech.SpeechError('word-timed OpenAI transcription does not label speakers; choose Scribe')
  let assetId: string | undefined
  let pageId = request.page_id
  if (request.kind === 'transcribe') {
    const [media] = await db
      .select()
      .from(t.sceneMedia)
      .where(and(eq(t.sceneMedia.canvasId, canvasId), eq(t.sceneMedia.id, request.media_id ?? '')))
    if (!media) throw new speech.SpeechError('no such media on this canvas')
    assetId = media.assetId
    pageId = media.pageId
    const [asset] = await db
      .select()
      .from(t.assets)
      .where(and(eq(t.assets.id, assetId), eq(t.assets.canvasId, canvasId)))
    if (!asset || (!asset.mime.startsWith('audio/') && !asset.mime.startsWith('video/')))
      throw new speech.SpeechError('media must reference an audio or video asset on this canvas')
    if (asset.size > 25 * 1024 * 1024) throw new speech.SpeechError('audio must be within 25 MiB')
  } else {
    if (!request.text || !pageId || !request.voice) throw new speech.SpeechError('text, voice and page_id are required')
    const composition = store.getComposition(canvasId, pageId)
    if (!composition || request.at >= composition.duration)
      throw new speech.SpeechError('voice-over needs a composition and at within its duration')
  }
  if (!canvasPages(store.getCanvas(canvasId)!).some((page) => page.id === pageId))
    throw new speech.SpeechError('no such page')
  request.page_id = pageId
  const quote = estimateSpeech(request)
  if (route.target === 'cloud' && (request.max_cost === undefined || request.max_cost < quote.usd))
    throw new speech.SpeechError(
      `show the estimate and supply max_cost of at least ${quote.usd} USD to run in the cloud`,
    )
  const modelId =
    request.model ??
    (route.target === 'cloud'
      ? request.kind === 'speak'
        ? 'eleven_v4'
        : request.provider === 'openai'
          ? 'whisper-1'
          : 'scribe_v3'
      : route.modelId)
  if (!modelId) throw new speech.SpeechError('choose an installed model')
  if (route.target !== 'cloud' && request.model && route.modelId !== request.model)
    throw new speech.SpeechError('requested model is not installed on the selected target')
  if (
    route.target === 'cloud' &&
    request.kind === 'transcribe' &&
    modelId !== (request.provider === 'openai' ? 'whisper-1' : 'scribe_v3')
  )
    throw new speech.SpeechError('unsupported word-timed transcription model')
  const job = await speech
    .createJob(userId, {
      kind: request.kind,
      target: route.target,
      modelId,
      inputAssetId: assetId,
      inputText: request.text,
      canvasId,
      mediaId: request.media_id,
      request,
    })
    .catch(() => {
      throw new speech.SpeechError('cannot create speech job; finish or cancel your active job first')
    })
  speechProgress(canvasId, job)
  if (route.target !== 'desktop') void runSpeechJob(job) // handles its own failure, never replays a paid request
  return job
}

function checkedTranscript(raw: unknown, job: SpeechJob): Transcript {
  const transcript = parseTranscript(raw)
  if (!transcript || transcript.words.length === 0) throw new speech.SpeechError('engine returned no valid timed words')
  return { ...transcript, model: job.modelId, target: job.target, jobId: job.id }
}

/** Desktop and internal workers finish through the same validation. Audio
 * bytes are sniffed and stored by the upload endpoint before this function. */
export async function completeSpeechJob(job: SpeechJob, raw: unknown, outputAssetId?: string): Promise<SpeechJob> {
  if (!job.canvasId || !job.request) throw new speech.SpeechError('job request is missing')
  assertEditor(job.requestedBy, job.canvasId)
  const transcript = checkedTranscript(raw, job)
  const canvasId = job.canvasId
  const request = job.request
  if (job.kind === 'speak') {
    const comp = store.getComposition(canvasId, request.page_id ?? '')
    if (!comp || !outputAssetId) throw new speech.SpeechError('voice output and composition are required')
    const end = Math.max(...transcript.words.map((word) => word.end))
    if (end <= 0 || end + request.at > comp.duration || end > MOTION_LIMITS.MAX_DURATION_S)
      throw new speech.SpeechError('voice-over exceeds the composition; extend it and retry')
  }
  const finished = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(t.speechJobs)
      .set({
        state: 'done',
        progress: 1,
        output: transcript,
        outputAssetId: outputAssetId ?? null,
        updatedAt: Date.now(),
      })
      .where(and(eq(t.speechJobs.id, job.id), eq(t.speechJobs.state, 'running')))
      .returning()
    if (!updated) throw new speech.SpeechError('job is no longer running')
    if (job.kind === 'transcribe') {
      const media = await tx
        .update(t.sceneMedia)
        .set({ transcript, updatedAt: Date.now() })
        .where(and(eq(t.sceneMedia.id, job.mediaId ?? ''), eq(t.sceneMedia.canvasId, canvasId)))
        .returning()
      if (!media[0]) throw new speech.SpeechError('media no longer exists')
    } else {
      await tx.insert(t.sceneMedia).values({
        id: nanoid(10),
        canvasId,
        pageId: request.page_id!,
        assetId: outputAssetId!,
        kind: 'audio',
        trimIn: 0,
        cuts: [],
        transcript,
        generation: {
          provider: job.target === 'cloud' ? 'elevenlabs' : job.target,
          model: job.modelId,
          voice: request.voice,
          text: request.text,
          cost: estimateSpeech(request).usd,
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    }
    return {
      ...job,
      state: 'done' as const,
      progress: 1,
      output: transcript,
      outputAssetId,
      updatedAt: updated.updatedAt,
    }
  })
  if (job.kind === 'speak') {
    const comp = store.getComposition(canvasId, request.page_id!)!
    const lane = comp?.tracks.find((track) => track.kind === 'audio')
    const trackId = lane?.id ?? nanoid(10)
    const clip = {
      id: nanoid(10),
      start: request.at,
      duration: Math.max(...transcript.words.map((word) => word.end)),
      source: { type: 'asset' as const, assetId: outputAssetId! },
    }
    const currentCanvas = store.getCanvas(canvasId)
    const result =
      currentCanvas && canEditCanvas(job.requestedBy, currentCanvas)
        ? patchComposition(
            canvasId,
            request.page_id!,
            [
              ...(!lane
                ? [{ op: 'add_track' as const, track: { id: trackId, kind: 'audio' as const, name: 'Voice-over' } }]
                : []),
              { op: 'add_clip', trackId, clip },
            ],
            { name: 'Speech', kind: 'user', color: 'blue' },
          )
        : { ok: false as const, error: 'canvas edit access was revoked' }
    if (!result.ok) {
      await db
        .update(t.speechJobs)
        .set({
          state: 'failed',
          error: 'audio generated but timeline insertion failed; use the output asset to insert it',
          updatedAt: Date.now(),
        })
        .where(eq(t.speechJobs.id, job.id))
      const failed = {
        ...finished,
        state: 'failed' as const,
        error: 'audio generated but timeline insertion failed; use the output asset to insert it',
      }
      speechProgress(canvasId, failed)
      return failed
    }
  }
  if (job.mediaId) mediaTranscribed(canvasId, job.mediaId, transcript)
  speechProgress(canvasId, finished)
  return finished
}

/** speakers are renamed once per media; a name may only label an S<n> the
 *  transcript actually produced (18.8) */
export async function renameSpeakers(
  userId: string,
  canvasId: string,
  mediaId: string,
  names: Record<string, string>,
): Promise<Transcript> {
  assertEditor(userId, canvasId)
  const [media] = await db
    .select()
    .from(t.sceneMedia)
    .where(and(eq(t.sceneMedia.id, mediaId), eq(t.sceneMedia.canvasId, canvasId)))
  if (!media?.transcript) throw new speech.SpeechError('media has no transcript yet')
  for (const key of Object.keys(names))
    if (!media.transcript.words.some((word) => word.speaker === key))
      throw new speech.SpeechError(`${key} is not a speaker of this media`)
  const transcript: Transcript = {
    ...media.transcript,
    speakers: { ...media.transcript.speakers, ...names },
  }
  await db
    .update(t.sceneMedia)
    .set({ transcript, updatedAt: Date.now() })
    .where(and(eq(t.sceneMedia.id, mediaId), eq(t.sceneMedia.canvasId, canvasId)))
  mediaTranscribed(canvasId, mediaId, transcript)
  return transcript
}

export function sniffSpeechAudio(bytes: Buffer): { mime: string; ext: string } {
  if (bytes.length === 0 || bytes.length > 25 * 1024 * 1024) throw new speech.SpeechError('audio must be within 25 MiB')
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE')
    return { mime: 'audio/wav', ext: 'wav' }
  if (bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0))
    return { mime: 'audio/mpeg', ext: 'mp3' }
  throw new speech.SpeechError('output must be WAV or MP3 audio')
}

async function runSpeechJob(job: SpeechJob): Promise<void> {
  try {
    const [claimed] = await db
      .update(t.speechJobs)
      .set({ state: 'running', updatedAt: Date.now() })
      .where(and(eq(t.speechJobs.id, job.id), eq(t.speechJobs.state, 'queued')))
      .returning()
    if (!claimed || !job.canvasId || !job.request) return
    job.state = 'running'
    assertEditor(job.requestedBy, job.canvasId)
    const request = job.request
    speechProgress(job.canvasId, job)
    let result: unknown
    let audio: Buffer | undefined
    if (job.target === 'server') {
      const source = job.inputAssetId ? await getAsset(job.inputAssetId) : undefined
      const body = await speech.sidecar(job.kind === 'transcribe' ? '/v1/transcribe' : '/v1/speak', {
        method: 'POST',
        body: JSON.stringify({ model_id: job.modelId, request, audio: source?.buf.toString('base64') }),
      })
      result = body.transcript
      if (typeof body.audio_base64 === 'string') audio = Buffer.from(body.audio_base64, 'base64')
    } else if (job.kind === 'transcribe') {
      const source = await getAsset(job.inputAssetId!)
      if (!source) throw new speech.SpeechError('audio asset is missing')
      result =
        request.provider === 'openai'
          ? await speech.openaiTranscribe(
              job.requestedBy,
              { buf: source.buf, name: `audio.${source.meta.ext}` },
              request,
            )
          : await speech.scribeTranscribe(
              job.requestedBy,
              { buf: source.buf, name: `audio.${source.meta.ext}` },
              request,
            )
    } else {
      const spoken = await speech.elevenLabsSpeak(job.requestedBy, {
        voiceId: request.voice!,
        text: request.text!,
        model: job.modelId,
      })
      result = spoken.transcript
      audio = spoken.audio
    }
    // Cancellation wins over a late provider response, before storing audio.
    if ((await speech.getJob(job.id))?.state !== 'running') return
    const asset = audio
      ? await storeAsset(audio, sniffSpeechAudio(audio), {
          canvasId: job.canvasId,
          ownerId: job.requestedBy,
          uploadedBy: job.requestedBy,
        })
      : undefined
    await completeSpeechJob(job, result, asset?.id)
  } catch {
    // Provider bodies, keys and sidecar diagnostics never enter a public job.
    const failed = await speech
      .finishJob(
        job.id,
        { state: 'failed', error: 'speech processing failed; check the connected account or speech service' },
        job.requestedBy,
      )
      .catch(() => undefined)
    if (failed?.canvasId) speechProgress(failed.canvasId, failed)
  }
}

/** Never retry a paid request automatically after a crash. */
export async function recoverSpeechJobs(): Promise<void> {
  await db
    .update(t.speechJobs)
    .set({ state: 'failed', error: 'server restarted; submit a new speech job', updatedAt: Date.now() })
    .where(inArray(t.speechJobs.state, ['queued', 'running']))
}
