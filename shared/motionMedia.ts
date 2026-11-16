/**
 * shared/motionMedia.ts — the `scene_media` contract (proposal 14.8–14.11,
 * phase 3).
 *
 * A media row is the per-page state of one `/a/` asset used on the timeline:
 * trim, cut ranges (transcript editing is data, nothing is re-encoded), beat
 * markers, the transcript with per-word timings and optional speakers, and
 * the recipe a generated layer was made with. Rows persist server-side
 * (`scene_media` table) while clips reference the asset; the helpers here are
 * pure so the editor, the tools and the renderers share one behaviour.
 */

import { nanoid } from 'nanoid'
import { MOTION_LIMITS, type MotionClip, type MotionKeyframe, type TranscriptWord } from './motion.ts'

export const MEDIA_KINDS = ['video', 'audio'] as const
export type MediaKind = (typeof MEDIA_KINDS)[number]

/** a word-timed transcript of the source media; `speakers` maps S1→name */
export interface Transcript {
  language: string
  words: TranscriptWord[]
  speakers?: Record<string, string>
  /** which engine ran it ('sherpa-onnx', 'whisper.cpp', 'elevenlabs', …) */
  engine?: string
  model?: string
  /** where it ran — 'desktop' | 'server' | 'cloud' */
  target?: string
  provider?: string
  jobId?: string
}

/** a source-time range excluded at playback and export (transcript cuts) */
export interface MediaCut {
  start: number
  end: number
}

/** onset markers + a BPM guess, computed once per asset */
export interface MediaBeats {
  markers: number[]
  bpm?: number
}

/** what a generated layer keeps so Regenerate/Vary can start from it */
export interface GenerationRecipe {
  provider: string
  model: string
  prompt?: string
  seed?: number
  refs?: string[]
  camera?: string
  /** voice-over recipe fields (14.11) */
  voice?: string
  text?: string
  style?: string
  language?: string
  cost?: number
}

export interface SceneMedia {
  id: string
  pageId: string
  assetId: string
  kind: MediaKind
  /** trim bounds in source seconds; trimOut null = to the asset's end */
  trimIn: number
  trimOut: number | null
  cuts: MediaCut[]
  beats?: MediaBeats
  transcript?: Transcript
  generation?: GenerationRecipe
}

/* ---- validation ---- */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function num(v: unknown, min: number, max: number): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null
}

export function parseTranscript(input: unknown): Transcript | null {
  if (!isRecord(input)) return null
  if (typeof input.language !== 'string' || input.language.length < 2 || input.language.length > 16) return null
  if (!Array.isArray(input.words) || input.words.length > 50_000) return null
  const words: TranscriptWord[] = []
  for (const w of input.words) {
    const word = parseWord(w)
    if (!word) return null
    words.push(word)
  }
  const out: Transcript = { language: input.language, words }
  if (input.speakers !== undefined) {
    if (!isRecord(input.speakers) || Object.keys(input.speakers).length > 32) return null
    const speakers: Record<string, string> = {}
    for (const [k, v] of Object.entries(input.speakers)) {
      if (typeof v !== 'string' || v.length < 1 || v.length > 80 || k.length > 40) return null
      speakers[k] = v
    }
    out.speakers = speakers
  }
  for (const f of ['engine', 'model', 'target', 'provider', 'jobId'] as const) {
    if (input[f] !== undefined) {
      if (typeof input[f] !== 'string' || (input[f] as string).length > 80) return null
      out[f] = input[f] as string
    }
  }
  return out
}

function parseWord(input: unknown): TranscriptWord | null {
  if (!isRecord(input)) return null
  const { text, start, end } = input
  if (typeof text !== 'string' || text.length < 1 || text.length > 200) return null
  const s = num(start, 0, MOTION_LIMITS.MAX_DURATION_S)
  const e = num(end, 0, MOTION_LIMITS.MAX_DURATION_S)
  if (s === null || e === null || e <= s) return null
  const out: TranscriptWord = { text, start: s, end: e }
  const c = num(input.confidence, 0, 1)
  if (c !== null) out.confidence = c
  if (typeof input.speaker === 'string' && input.speaker.length <= 40) out.speaker = input.speaker
  return out
}

/** validates a SceneMedia body for PUT; id/pageId/assetId come from the row */
export function parseMediaBody(input: unknown): Omit<SceneMedia, 'id' | 'pageId' | 'assetId'> | null {
  if (!isRecord(input)) return null
  const kind = input.kind
  if (kind !== 'video' && kind !== 'audio') return null
  const trimIn = num(input.trimIn, 0, MOTION_LIMITS.MAX_DURATION_S) ?? 0
  const trimOut =
    input.trimOut === null || input.trimOut === undefined ? null : num(input.trimOut, 0, MOTION_LIMITS.MAX_DURATION_S)
  if (trimOut !== null && trimOut <= trimIn) return null
  const out: Omit<SceneMedia, 'id' | 'pageId' | 'assetId'> = { kind, trimIn, trimOut, cuts: [] }
  if (input.cuts !== undefined) {
    if (!Array.isArray(input.cuts) || input.cuts.length > 2000) return null
    for (const c of input.cuts) {
      if (!isRecord(c)) return null
      const s = num(c.start, 0, MOTION_LIMITS.MAX_DURATION_S)
      const e = num(c.end, 0, MOTION_LIMITS.MAX_DURATION_S)
      if (s === null || e === null || e <= s) return null
      out.cuts.push({ start: s, end: e })
    }
  }
  if (input.beats !== undefined) {
    if (!isRecord(input.beats) || !Array.isArray(input.beats.markers) || input.beats.markers.length > 20_000)
      return null
    const markers: number[] = []
    for (const m of input.beats.markers) {
      const t = num(m, 0, MOTION_LIMITS.MAX_DURATION_S)
      if (t === null) return null
      markers.push(t)
    }
    const bpm = num(input.beats.bpm, 20, 400) ?? undefined
    out.beats = { markers, ...(bpm !== undefined ? { bpm } : {}) }
  }
  if (input.transcript !== undefined) {
    const transcript = parseTranscript(input.transcript)
    if (!transcript) return null
    out.transcript = transcript
  }
  if (input.generation !== undefined) {
    if (!isRecord(input.generation)) return null
    const g = input.generation
    if (
      typeof g.provider !== 'string' ||
      typeof g.model !== 'string' ||
      g.provider.length > 40 ||
      g.model.length > 80
    ) {
      return null
    }
    const gen: GenerationRecipe = { provider: g.provider, model: g.model }
    if (typeof g.prompt === 'string' && g.prompt.length <= 4000) gen.prompt = g.prompt
    const seed = num(g.seed, 0, Number.MAX_SAFE_INTEGER)
    if (seed !== null) gen.seed = seed
    if (Array.isArray(g.refs) && g.refs.every((r) => typeof r === 'string' && r.length <= 200))
      gen.refs = g.refs as string[]
    for (const f of ['camera', 'voice', 'text', 'style', 'language'] as const) {
      if (typeof g[f] === 'string' && (g[f] as string).length <= 4000) gen[f] = g[f] as string
    }
    const cost = num(g.cost, 0, 10_000)
    if (cost !== null) gen.cost = cost
    out.generation = gen
  }
  return out
}

/* ---- transcript editing: cuts are data (14.10) ---- */

/** drops the words whose span overlaps a cut range — the caption source and
 *  the edit surface both derive from this */
export function cutWords(words: readonly TranscriptWord[], cuts: readonly MediaCut[]): TranscriptWord[] {
  if (cuts.length === 0) return [...words]
  return words.filter((w) => !cuts.some((c) => w.start < c.end && w.end > c.start))
}

/** filler words a one-click "cut the ums" offers (14.10) */
export function findFillers(
  words: readonly TranscriptWord[],
  minSilence = 0.3,
): { wordRanges: MediaCut[]; silenceRanges: MediaCut[] } {
  const fillers = new Set(['um', 'uh', 'erm', 'euh', 'heu', 'hmm'])
  const wordRanges: MediaCut[] = []
  const silenceRanges: MediaCut[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (fillers.has(w.text.toLowerCase().replace(/[.,!?]/g, ''))) wordRanges.push({ start: w.start, end: w.end })
    const next = words[i + 1]
    if (next && next.start - w.end >= minSilence) silenceRanges.push({ start: w.end, end: next.start })
  }
  return { wordRanges, silenceRanges }
}

/* ---- captions from a transcript (14.9) ---- */

export interface CaptionOptions {
  /** words per caption line before a break */
  maxWords?: number
  /** max seconds on screen per caption */
  maxDuration?: number
  /** editor preset name written on each clip's source */
  style?: string
  /** 'words' keeps per-word timings for highlight styles (default true) */
  words?: boolean
}

/** folds a transcript into caption clips: a break on a speaker change, a
 *  sentence end past maxWords, or the max duration. Times are source media
 *  times — the caller offsets them onto the composition clock. */
export function captionsFromTranscript(transcript: Transcript, opts: CaptionOptions = {}): MotionClip[] {
  const { maxWords = 7, maxDuration = 4, style, words: keepWords = true } = opts
  const clips: MotionClip[] = []
  let chunk: TranscriptWord[] = []
  const flush = () => {
    if (chunk.length === 0) return
    const start = chunk[0]!.start
    const end = chunk[chunk.length - 1]!.end
    clips.push({
      id: nanoid(8),
      start,
      duration: Math.max(0.01, end - start),
      source: {
        type: 'caption',
        text: chunk.map((w) => w.text).join(' '),
        ...(style ? { style } : {}),
        ...(keepWords ? { words: chunk.map((w) => ({ ...w })) } : {}),
      },
    })
    chunk = []
  }
  for (const w of transcript.words) {
    const first = chunk[0]
    const speakerChanged = first && w.speaker && first.speaker && w.speaker !== first.speaker
    const full = chunk.length >= maxWords || (first && w.start - first.start >= maxDuration)
    if (speakerChanged || full) flush()
    chunk.push(w)
  }
  flush()
  return clips
}

/* ---- ducking (14.8) ---- */

/** gain keyframes ducking `music` under each voice range. Voice ranges are on
 *  the composition clock already; the keyframes land on an audio track's
 *  `gain` lane and stay editable. `depth` is the ducked gain (0–1 of normal),
 *  `attack`/`release` the seconds of ramp on each side. */
export function duckingKeyframes(
  voiceRanges: readonly { start: number; end: number }[],
  opts: { gain?: number; depth?: number; attack?: number; release?: number } = {},
): MotionKeyframe[] {
  const gain = opts.gain ?? 1
  const depth = opts.depth ?? 0.25
  const attack = opts.attack ?? 0.15
  const release = opts.release ?? 0.4
  const kf = (t: number, value: number, easing: MotionKeyframe['easing'] = { type: 'linear' }): MotionKeyframe => ({
    id: nanoid(8),
    property: 'gain',
    t: Math.max(0, t),
    value,
    easing,
  })
  const out: MotionKeyframe[] = [kf(0, gain, { type: 'hold' })]
  for (const r of [...voiceRanges].sort((a, b) => a.start - b.start)) {
    out.push(
      kf(r.start - attack, gain, { type: 'linear' }),
      kf(r.start, gain * depth, { type: 'hold' }),
      kf(r.end, gain * depth, { type: 'linear' }),
      kf(r.end + release, gain, { type: 'hold' }),
    )
  }
  return out
}

/** snap a time to the nearest beat marker within `tolerance` seconds */
export function snapToBeat(t: number, beats: MediaBeats | undefined, tolerance = 0.05): number {
  if (!beats) return t
  let best: number | undefined
  for (const m of beats.markers) {
    if (best === undefined || Math.abs(m - t) < Math.abs(best - t)) best = m
  }
  return best !== undefined && Math.abs(best - t) <= tolerance ? best : t
}
