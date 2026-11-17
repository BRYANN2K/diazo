/** Speech tool definitions are reused by both canvas tool transports. */
import { z } from 'zod'
import { speechRequestSchema } from '../shared/speech.ts'
import { catalog, getJob, listVoices, SpeechError, speechEnabled } from './speech.ts'
import { estimateSpeech, submitSpeech } from './speechJobs.ts'
import { canAccessCanvas, canEditCanvas } from './access.ts'
import type { Canvas } from '../shared/types.ts'
import { db } from './db/index.ts'
import { sceneMedia } from './db/schema.ts'
import { and, eq } from 'drizzle-orm'

export const SPEECH_TOOLS = [
  {
    name: 'list_speech_engines',
    title: 'List speech engines',
    description: 'List speech engines, install readiness and estimates. Local routing never falls back to cloud.',
    readOnly: true,
    shape: {},
  },
  {
    name: 'estimate_speech',
    title: 'Estimate a speech job',
    description: 'Estimate speech cost before running. Cloud execution requires max_cost at least this estimate.',
    readOnly: true,
    shape: { request: speechRequestSchema },
  },
  {
    name: 'transcribe_clip',
    title: 'Transcribe a clip',
    description:
      'Queue a word-timed transcript for media_id. Explicit cloud requests use your key and require seconds and max_cost. Poll get_transcript with job_id.',
    readOnly: false,
    shape: speechRequestSchema.omit({ kind: true, text: true, voice: true }).shape,
  },
  {
    name: 'generate_voiceover',
    title: 'Generate a voice-over',
    description:
      'Queue voice-over and insert an audio clip with its recipe and words. Requires text, voice and page_id. Cloud requests require max_cost from estimate_speech.',
    readOnly: false,
    shape: speechRequestSchema.omit({ kind: true, media_id: true }).shape,
  },
  {
    name: 'get_transcript',
    title: 'Read a transcript',
    description: 'Read your speech job by job_id, or the transcript of media_id on this canvas.',
    readOnly: true,
    shape: { job_id: z.string().optional(), media_id: z.string().optional() },
  },
  {
    name: 'list_voices',
    title: 'List your voices',
    description: 'List your local cloned voices. Voice samples remain on this instance.',
    readOnly: true,
    shape: {},
  },
] as const

export async function runSpeechTool(name: string, canvas: Canvas, userId: string, raw: unknown): Promise<unknown> {
  if (!speechEnabled()) throw new SpeechError('speech is disabled')
  if (!canAccessCanvas(userId, canvas)) throw new SpeechError('canvas view access required')
  const tool = SPEECH_TOOLS.find((item) => item.name === name)
  if (!tool) throw new SpeechError('unknown speech tool')
  if (!tool.readOnly && !canEditCanvas(userId, canvas)) throw new SpeechError('canvas edit access required')
  const parsed = z.object(tool.shape).strict().safeParse(raw)
  if (!parsed.success) throw new SpeechError(parsed.error.issues[0]?.message ?? 'invalid speech arguments')
  const input = parsed.data as Record<string, unknown>
  switch (name) {
    case 'list_speech_engines':
      return catalog(userId)
    case 'estimate_speech':
      return estimateSpeech(speechRequestSchema.parse(input.request))
    case 'transcribe_clip':
      return { job: await submitSpeech(userId, canvas.id, { ...input, kind: 'transcribe' }) }
    case 'generate_voiceover':
      return { job: await submitSpeech(userId, canvas.id, { ...input, kind: 'speak' }) }
    case 'list_voices':
      return { voices: await listVoices(userId) }
    case 'get_transcript': {
      if (typeof input.job_id === 'string') {
        const job = await getJob(input.job_id)
        if (!job || job.requestedBy !== userId || job.canvasId !== canvas.id)
          throw new SpeechError('no such speech job')
        return { job }
      }
      const [media] = await db
        .select()
        .from(sceneMedia)
        .where(and(eq(sceneMedia.canvasId, canvas.id), eq(sceneMedia.id, String(input.media_id ?? ''))))
      if (!media) throw new SpeechError('no such media')
      return { transcript: media.transcript }
    }
  }
}
