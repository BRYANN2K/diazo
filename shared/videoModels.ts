/**
 * shared/videoModels.ts — the generate_video registry (proposal 3.1, 14.11).
 *
 * Video generation runs on the person's own account: OpenRouter first (one
 * endpoint for Veo/Omni/Kling/Seedance, `POST /api/v1/videos` + poll),
 * Gemini second (Omni Flash on the existing Gemini key). No OpenAI video —
 * the Sora API is gone, and the picker says so instead of hiding it.
 * Prices are per generated second, dated, and shown before a run.
 */

export const VIDEO_PRICE_DATE = '2026-02'

export const VIDEO_ASPECTS = ['16:9', '9:16', '1:1'] as const
export type VideoAspect = (typeof VIDEO_ASPECTS)[number]

export interface VideoModelOption {
  /** the id sent to the provider */
  id: string
  /** the account kind that can run it */
  provider: 'openrouter' | 'gemini'
  label: string
  /** seconds the model accepts */
  lengths: number[]
  aspects: readonly VideoAspect[]
  /** USD per generated second, as of VIDEO_PRICE_DATE */
  pricePerSecond: number
  note?: string
}

export const VIDEO_MODELS: readonly VideoModelOption[] = [
  {
    id: 'google/veo-3.1',
    provider: 'openrouter',
    label: 'Veo 3.1',
    lengths: [4, 6, 8],
    aspects: VIDEO_ASPECTS,
    pricePerSecond: 0.4,
    note: 'OpenRouter video API (alpha): POST /api/v1/videos, poll the job',
  },
  {
    /* the Veo preview ids on the Gemini API were shut down 2026-10-22;
     * Google names gemini-omni-1.2-flash as the migration target */
    id: 'gemini-omni-1.2-flash',
    provider: 'gemini',
    label: 'Gemini Omni Flash',
    lengths: [4, 8, 15],
    aspects: ['16:9', '9:16'],
    pricePerSecond: 0.07,
    note: 'First and last frame, up to 15 s and 4K',
  },
]

export function videoModel(id: string | undefined): VideoModelOption | undefined {
  return VIDEO_MODELS.find((m) => m.id === id) ?? (id === undefined ? VIDEO_MODELS[0] : undefined)
}
