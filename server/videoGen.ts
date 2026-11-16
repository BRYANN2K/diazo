/**
 * server/videoGen.ts — the generate_video engine (proposal 3.1, 14.11).
 *
 * Mirrors imageGen.ts: the person picks a video model from the shared
 * VIDEO_MODELS registry, each option names the credential that can run it
 * (openrouter-key or gemini-key), and whoever pays for the agent run pays
 * for the clip — nobody's key draws for someone else. The call is a
 * long-running job on the provider's side; we poll, download the bytes, and
 * the caller stores them as an /a/ asset with the recipe kept on the media
 * row (regenerate starts from it).
 *
 * The OpenRouter video API is alpha and the Gemini Omni shape is new: keep
 * every request detail in this one module so an upstream change is a local
 * fix.
 */

import { env } from './env.ts'
import { getAccounts } from './modelAccounts.ts'
import { fetchRemote } from './assets.ts'
import { videoModel, type VideoAspect, type VideoModelOption } from '../shared/videoModels.ts'

const FETCH_TIMEOUT_MS = 60_000
const POLL_EVERY_MS = 5_000
const POLL_DEADLINE_MS = 12 * 60 * 1000
/** generated clips are seconds long — anything beyond this is not a clip */
const MAX_VIDEO_BYTES = 512 * 1024 * 1024

export interface VideoRequest {
  prompt: string
  model?: string
  /** seconds; defaults to the model's shortest length */
  seconds?: number
  aspect?: VideoAspect
  seed?: number
  /** /a/ asset ids or data URLs for the first/last frame, where the model takes them */
  firstFrame?: string
  lastFrame?: string
  /** reference images the model accepts */
  refs?: string[]
}

export interface GeneratedVideo {
  buf: Buffer
  mime: string
  ext: string
  /** the recipe kept on the media row */
  recipe: { provider: string; model: string; prompt: string; seed?: number; cost: number }
  seconds: number
}

export class VideoGenError extends Error {}

/* ---- the result download ---- */

/** Trust the bytes, not the provider's content-type: mp4 and webm are the
 *  only containers a clip lands as — an error page or anything else is
 *  refused rather than stored and served under the app origin. */
export function sniffVideoMime(buf: Buffer): 'video/mp4' | 'video/webm' | undefined {
  /* iso-bmff: size + 'ftyp' + a known major brand */
  if (
    buf.length >= 12 &&
    buf.toString('latin1', 4, 8) === 'ftyp' &&
    /^(isom|iso2|iso4|iso5|iso6|avc1|mp41|mp42|dash|MSNV|M4V |M4A |qt {2}|heic|heix)/.test(
      buf.toString('latin1', 8, 12),
    )
  )
    return 'video/mp4'
  /* ebml/webm */
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video/webm'
  return undefined
}

/** Download a provider result through the SSRF-pinned fetch (every
 *  redirect re-validated, streamed under a hard cap), then keep it only
 *  if it really is video. */
export async function downloadVideo(url: string, headers?: Record<string, string>): Promise<Buffer> {
  const buf = await fetchRemote(url, MAX_VIDEO_BYTES, {
    accept: 'video/*,*/*;q=0.8',
    headers,
    timeoutMs: FETCH_TIMEOUT_MS * 2,
  }).catch((error) => {
    throw error instanceof VideoGenError
      ? error
      : new VideoGenError(error instanceof Error ? error.message : String(error))
  })
  if (!sniffVideoMime(buf)) {
    throw new VideoGenError('the provider sent no playable video — refusing to store it')
  }
  return buf
}

/* ---- provider calls ---- */

async function fetchJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const msg = (body.error as { message?: string } | undefined)?.message ?? `HTTP ${res.status}`
    throw new VideoGenError(msg)
  }
  return body
}

async function openRouterVideo(key: string, model: VideoModelOption, req: VideoRequest): Promise<GeneratedVideo> {
  const create = await fetchJson(env.OPENROUTER_VIDEOS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model.id,
      prompt: req.prompt,
      duration: req.seconds,
      aspect_ratio: req.aspect,
      seed: req.seed,
      image: req.firstFrame,
      last_image: req.lastFrame,
      reference_images: req.refs,
    }),
  })
  const jobId = typeof create.id === 'string' ? create.id : undefined
  if (!jobId) throw new VideoGenError('OpenRouter returned no video job id')
  const deadline = Date.now() + POLL_DEADLINE_MS
  for (;;) {
    if (Date.now() > deadline) throw new VideoGenError('the video job timed out')
    await new Promise((r) => setTimeout(r, POLL_EVERY_MS))
    const job = await fetchJson(`${env.OPENROUTER_VIDEOS_URL}/${jobId}`, {
      headers: { Authorization: `Bearer ${key}` },
    })
    const status = String(job.status ?? '')
    if (status === 'failed' || status === 'error') {
      throw new VideoGenError(
        String((job.error as { message?: string } | undefined)?.message ?? 'the video job failed'),
      )
    }
    if (status !== 'completed' && status !== 'succeeded') continue
    const url =
      (job.video as { url?: string } | undefined)?.url ??
      (Array.isArray(job.data) ? (job.data[0] as { url?: string } | undefined)?.url : undefined) ??
      (job.output as { url?: string } | undefined)?.url
    if (!url) throw new VideoGenError('the finished job carries no video url')
    const buf = await downloadVideo(url)
    return finish(buf, sniffVideoMime(buf)!, 'openrouter', model, req)
  }
}

async function geminiVideo(key: string, model: VideoModelOption, req: VideoRequest): Promise<GeneratedVideo> {
  const instance: Record<string, unknown> = { prompt: req.prompt }
  if (req.firstFrame) instance.image = { bytesBase64Encoded: req.firstFrame }
  if (req.lastFrame) instance.lastFrame = { bytesBase64Encoded: req.lastFrame }
  const op = await fetchJson(`${env.GEMINI_VIDEOS_URL}/${model.id}:predictLongRunning?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances: [instance],
      parameters: {
        aspectRatio: req.aspect,
        durationSeconds: req.seconds,
        seed: req.seed,
        ...(req.refs?.length ? { referenceImages: req.refs.map((r) => ({ bytesBase64Encoded: r })) } : {}),
      },
    }),
  })
  const name = typeof op.name === 'string' ? op.name : undefined
  if (!name) throw new VideoGenError('Gemini returned no operation name')
  const deadline = Date.now() + POLL_DEADLINE_MS
  for (;;) {
    if (Date.now() > deadline) throw new VideoGenError('the video operation timed out')
    await new Promise((r) => setTimeout(r, POLL_EVERY_MS))
    const job = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/${name}?key=${key}`, {})
    if (!job.done) continue
    if (job.error) throw new VideoGenError(String((job.error as { message?: string }).message))
    const response = job.response as { generateVideoResponse?: { generatedSamples?: { video?: { uri?: string } }[] } }
    const uri = response.generateVideoResponse?.generatedSamples?.[0]?.video?.uri
    if (!uri) throw new VideoGenError('the finished operation carries no video uri')
    /* the download uri wants the same credential as the api call */
    const buf = await downloadVideo(uri, { 'x-goog-api-key': key })
    return finish(buf, sniffVideoMime(buf)!, 'gemini', model, req)
  }
}

function finish(
  buf: Buffer,
  mime: string,
  provider: string,
  model: VideoModelOption,
  req: VideoRequest,
): GeneratedVideo {
  const seconds = req.seconds ?? model.lengths[0]!
  return {
    buf,
    mime,
    ext: mime === 'video/webm' ? 'webm' : 'mp4',
    recipe: {
      provider,
      model: model.id,
      prompt: req.prompt,
      ...(req.seed !== undefined ? { seed: req.seed } : {}),
      cost: seconds * model.pricePerSecond,
    },
    seconds,
  }
}

/** the account that can run `model`; OpenRouter first, Gemini second */
export async function generateVideo(payerId: string, req: VideoRequest): Promise<GeneratedVideo> {
  const model = videoModel(req.model)
  if (!model) return Promise.reject(new VideoGenError(`unknown video model ${req.model} — see VIDEO_MODELS`))
  if (req.seconds !== undefined && !model.lengths.includes(req.seconds)) {
    return Promise.reject(new VideoGenError(`${model.label} takes ${model.lengths.join('/')} s, not ${req.seconds}`))
  }
  const accounts = await getAccounts(payerId)
  const account =
    model.provider === 'openrouter'
      ? accounts.find((a) => a.kind === 'openrouter-key' && a.enabled && a.apiKey)
      : accounts.find((a) => a.kind === 'gemini-key' && a.enabled && a.apiKey)
  if (!account?.apiKey) {
    const kind = model.provider === 'openrouter' ? 'an OpenRouter' : 'a Gemini'
    return Promise.reject(new VideoGenError(`${model.label} needs ${kind} key connected in Settings → Diazo Agent`))
  }
  const seconds = req.seconds ?? model.lengths[0]!
  const req2 = { ...req, seconds }
  return model.provider === 'openrouter'
    ? openRouterVideo(account.apiKey, model, req2)
    : geminiVideo(account.apiKey, model, req2)
}

/** what a call costs, for the estimate the panel shows before a run */
export function videoCost(model: VideoModelOption, seconds?: number): number {
  return (seconds ?? model.lengths[0]!) * model.pricePerSecond
}
