/**
 * shared/speech.ts — the speech contract (proposal 18, ADR 0014).
 *
 * Transcription and voice-over install in one click on the person's Mac
 * (desktop app) or on the Diazo server (a `diazo-speech` sidecar, admins
 * only), their choice, plus cloud on their own key when they pick it. The
 * catalog below is the fixed curated menu on both targets; a person (or a
 * server admin) can also add their own model (18.9) — pinned commit, every
 * file size + SHA-256 checked, licence acknowledged, disabled until its
 * smoke test passes.
 */

import { z } from 'zod'

/* ---- engines, runtimes, targets (18.1) ---- */

export const SPEECH_RUNTIMES = ['sherpa-onnx', 'whisper.cpp', 'mlx-audio', 'pocket-tts', 'pyannote'] as const
export type SpeechRuntime = (typeof SPEECH_RUNTIMES)[number]

export const SPEECH_TARGETS = ['desktop', 'server', 'cloud'] as const
export type SpeechTarget = (typeof SPEECH_TARGETS)[number]

export const SPEECH_KINDS = ['asr', 'tts', 'speakers'] as const
export type SpeechKind = (typeof SPEECH_KINDS)[number]

/* ---- the fixed catalog (18.3, 18.5) ----
 * One entry per menu row. `files` pins the download: repository + commit +
 * per-file sha256 (the desktop checks the mirror's signature first, then
 * each hash; HF's own metadata supplies hashes for non-mirrored files).
 * Sizes are bytes; `slow` marks what the menu warns about on a CPU VPS. */

export interface CatalogFile {
  path: string
  bytes: number
  /** hex SHA-256; '' means "take it from HF metadata at the pinned commit" */
  sha256: string
}

export interface CatalogEntry {
  id: string
  label: string
  kind: SpeechKind
  runtime: SpeechRuntime
  /** targets this entry installs on */
  targets: readonly ('desktop' | 'server')[]
  /** hugging face repo + pinned commit, or 'mirror' for our own release */
  source: { type: 'hf'; repo: string; commit: string } | { type: 'mirror'; release: string }
  files: CatalogFile[]
  /** estimated seconds of audio per second of media on each target */
  speed?: { desktop?: string; server?: string }
  /** preselected in the menu */
  default?: boolean
  slow?: boolean
  note?: string
}

export const SPEECH_CATALOG: readonly CatalogEntry[] = [
  /* -- transcription (18.3) -- */
  {
    id: 'parakeet-tdt-0.6b-v3',
    label: 'Fast, 25 European languages',
    kind: 'asr',
    runtime: 'sherpa-onnx',
    targets: ['desktop', 'server'],
    source: { type: 'hf', repo: 'sherpa-onnx/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8', commit: 'main' },
    files: [{ path: 'model.int8.onnx', bytes: 510_000_000, sha256: '' }],
    default: true,
    note: 'Parakeet TDT 0.6B v3 int8, CC-BY-4.0, native word timings',
  },
  {
    id: 'whisper-large-v3-turbo',
    label: 'Any language',
    kind: 'asr',
    runtime: 'whisper.cpp',
    targets: ['desktop', 'server'],
    source: { type: 'hf', repo: 'ggerganov/whisper.cpp', commit: 'main' },
    files: [{ path: 'ggml-large-v3-turbo-q5_0.bin', bytes: 602_000_000, sha256: '' }],
    note: 'Whisper large-v3-turbo q5_0, MIT, --dtw token timings',
  },
  {
    id: 'whisper-large-v3',
    label: 'Best Whisper',
    kind: 'asr',
    runtime: 'whisper.cpp',
    targets: ['desktop', 'server'],
    source: { type: 'hf', repo: 'ggerganov/whisper.cpp', commit: 'main' },
    files: [{ path: 'ggml-large-v3-q5_0.bin', bytes: 1_130_000_000, sha256: '' }],
    slow: true,
    note: 'Whisper large-v3 q5_0, MIT — marked slow on the VPS',
  },
  /* -- voice-over (18.5) -- */
  {
    id: 'voxcpm2-8bit',
    label: 'Studio: VoxCPM2',
    kind: 'tts',
    runtime: 'mlx-audio',
    targets: ['desktop'],
    source: { type: 'hf', repo: 'mlx-community/VoxCPM2-8bit', commit: 'main' },
    files: [{ path: 'model.safetensors', bytes: 2_200_000_000, sha256: '' }],
    default: true,
    note: 'Apache-2.0, French + cloning; Apple silicon only',
  },
  {
    id: 'qwen3-tts-1.7b',
    label: 'Studio: Qwen3-TTS',
    kind: 'tts',
    runtime: 'mlx-audio',
    targets: ['desktop'],
    source: { type: 'hf', repo: 'mlx-community/Qwen3-TTS-1.7B-8bit', commit: 'main' },
    files: [{ path: 'model.safetensors', bytes: 1_800_000_000, sha256: '' }],
    note: 'Apache-2.0, cloning from 3 s + transcript',
  },
  {
    id: 'ming-3.0-tts',
    label: 'Studio: Ming-3.0',
    kind: 'tts',
    runtime: 'mlx-audio',
    targets: ['desktop'],
    source: { type: 'hf', repo: 'mlx-community/Ming-3.0-TTS-8bit', commit: 'main' },
    files: [{ path: 'model.safetensors', bytes: 600_000_000, sha256: '' }],
    note: 'MIT, emotion/speed/pitch controls; French is its weakest side',
  },
  {
    id: 'pocket-tts',
    label: 'Fast voice',
    kind: 'tts',
    runtime: 'pocket-tts',
    targets: ['desktop', 'server'],
    source: { type: 'mirror', release: 'speech-models-v1' },
    /* mirrored from kyutai/pocket-tts at the pinned commit — see
       docs/speech-mirror.md; attribution ships beside the weights */
    files: [{ path: 'pocket-tts.safetensors', bytes: 200_000_000, sha256: '' }],
    default: true,
    note: 'CC-BY-4.0, ~6x real time on two cores — the server default',
  },
  {
    id: 'qwen3-tts-0.6b-gguf',
    label: 'Studio on CPU (slow)',
    kind: 'tts',
    runtime: 'sherpa-onnx',
    targets: ['server'],
    source: { type: 'hf', repo: 'Qwen/Qwen3-TTS-0.6B-GGUF', commit: 'main' },
    files: [{ path: 'qwen3-tts-0.6b-int8.gguf', bytes: 700_000_000, sha256: '' }],
    slow: true,
    note: 'GGUF C++ port, ~3x RTF on 4 vCPU — for admins who want a studio voice on the VPS',
  },
  {
    id: 'kokoro-82m',
    label: 'Quick preview, English only',
    kind: 'tts',
    runtime: 'sherpa-onnx',
    targets: ['desktop', 'server'],
    source: { type: 'hf', repo: 'sherpa-onnx/kokoro-en-v0_19', commit: 'main' },
    files: [{ path: 'model.onnx', bytes: 88_000_000, sha256: '' }],
    note: 'Apache-2.0, instant — its French voice is weak, so English only',
  },
  /* -- speaker labels (18.8) -- */
  {
    id: 'speaker-segmentation',
    label: 'Speaker labels',
    kind: 'speakers',
    runtime: 'sherpa-onnx',
    targets: ['desktop', 'server'],
    source: { type: 'hf', repo: 'sherpa-onnx/sherpa-onnx-pyannote-segmentation-3-0', commit: 'main' },
    files: [{ path: 'model.onnx', bytes: 7_300_000, sha256: '' }],
    note: 'pyannote segmentation-3.0 (MIT) + CAM++ embedding — no gate, no token',
  },
]

export function catalogEntry(id: string): CatalogEntry | undefined {
  return SPEECH_CATALOG.find((e) => e.id === id)
}

/* ---- installs, jobs, preferences, custom models, voices (18.13) ---- */

export const INSTALL_STATES = ['downloading', 'verifying', 'ready', 'failed'] as const
export type InstallState = (typeof INSTALL_STATES)[number]

export interface SpeechInstall {
  id: string
  /** 'server' rows persist; desktop installs live in the shell's speech.json
   *  and are reported with each poll */
  target: 'desktop' | 'server'
  modelId: string
  engine: SpeechRuntime
  revision: string
  state: InstallState
  bytes: number
  error?: string
  installedBy: string
  installedAt: number
  lastUsedAt?: number
}

export const SPEECH_JOB_STATES = ['queued', 'running', 'done', 'failed', 'canceled'] as const
export type SpeechJobState = (typeof SPEECH_JOB_STATES)[number]

export interface SpeechJob {
  id: string
  kind: 'transcribe' | 'speak'
  target: SpeechTarget
  /** the desktop device a 'desktop' job addresses */
  deviceId?: string
  modelId: string
  /** /a/ asset for transcribe; text for speak */
  inputAssetId?: string
  inputText?: string
  state: SpeechJobState
  progress: number
  /** transcribe output: the Transcript written onto scene_media */
  request?: SpeechRequest
  output?: unknown
  outputAssetId?: string
  requestedBy: string
  error?: string
  canvasId?: string
  mediaId?: string
  createdAt: number
  updatedAt: number
}

export const ROUTE_TARGETS = ['auto', 'desktop', 'server', 'cloud'] as const
export type RouteTarget = (typeof ROUTE_TARGETS)[number]

export interface SpeechPreferences {
  transcribeTarget: RouteTarget
  voiceTarget: RouteTarget
  modelId?: string
  cloudProvider?: 'elevenlabs' | 'openai'
  voiceProvider?: 'local' | 'elevenlabs'
  voice?: string
  language?: string
  speakers: boolean
}

export const DEFAULT_PREFERENCES: SpeechPreferences = {
  transcribeTarget: 'auto',
  voiceTarget: 'auto',
  speakers: false,
}

export interface CustomModelFile {
  path: string
  bytes: number
  sha256: string
}

export interface CustomModel {
  id: string
  /** a user id, or 'instance' for the server target */
  owner: string
  target: 'desktop' | 'server'
  kind: SpeechKind
  runtime: SpeechRuntime
  source: { type: 'hf'; repo: string; commit: string } | { type: 'local' }
  files: CustomModelFile[]
  licenseId?: string
  licenseText?: string
  licenseAckBy?: string
  licenseAckAt?: number
  /** sealed HF token for gated repos — never shown back */
  hasToken: boolean
  smokeTest?: { ok: boolean; log: string; tookMs: number; at: number }
  enabled: boolean
  createdAt: number
}

export interface Voice {
  id: string
  ownerId: string
  name: string
  /** the private consent sample asset */
  sampleAssetId: string
  sampleTranscript?: string
  consentAt: number
  engines: SpeechRuntime[]
  createdAt: number
}

/* ---- ElevenLabs (18.6) ---- */

export const ELEVENLABS_MODELS = [
  { id: 'eleven_v4', label: 'eleven v4', chars: 10_000, per1k: 0.08 },
  { id: 'eleven_v4_turbo', label: 'eleven v4 turbo', chars: 10_000, per1k: 0.04 },
  { id: 'eleven_v3', label: 'eleven v3', chars: 5_000, per1k: 0.08 },
  { id: 'eleven_multilingual_v2', label: 'multilingual v2', chars: 10_000, per1k: 0.08 },
  { id: 'eleven_flash_v2_5', label: 'flash v2.5', chars: 40_000, per1k: 0.04 },
] as const

export const ELEVENLABS_PRICE_DATE = '2026-02'
/** Scribe: USD per hour of audio */
export const SCRIBE_PRICE_PER_HOUR = 0.2

/* ---- route resolution (18.12) ----
 * `auto` = desktop when this person's app is online with the model, else the
 * server when it has it, else "install" — never cloud (sending audio out is
 * always an explicit pick). */

export interface RouteAnswer {
  target: SpeechTarget | 'install'
  modelId?: string
  reason: string
}

export function routeTarget(
  want: RouteTarget,
  kind: SpeechKind,
  online: { desktop: boolean; server: boolean },
  installed: { desktop: string[]; server: string[] },
  defaultModel?: string,
): RouteAnswer {
  if (want === 'cloud') return { target: 'cloud', reason: 'you picked the cloud — audio leaves the instance' }
  const targets = want === 'auto' ? (['desktop', 'server'] as const) : [want]
  for (const target of targets) {
    const candidates = SPEECH_CATALOG.filter((entry) => entry.kind === kind && entry.targets.includes(target))
    const model = defaultModel ?? candidates.find((entry) => entry.default)?.id ?? candidates[0]?.id
    if (online[target] && model && installed[target].includes(model)) {
      return { target, modelId: model, reason: `installed and online on the ${target}` }
    }
  }
  return {
    target: 'install',
    modelId: defaultModel,
    reason: 'no online target has the requested model — install it first',
  }
}

/** One validated request shared by REST, MCP and the resident tools. Cloud
 * jobs require explicit consent to the estimate returned before execution. */
export const speechRequestSchema = z
  .object({
    kind: z.enum(['transcribe', 'speak']),
    target: z.enum(ROUTE_TARGETS).optional(),
    model: z.string().min(1).max(100).optional(),
    media_id: z.string().min(1).max(100).optional(),
    page_id: z.string().min(1).max(100).optional(),
    language: z.string().min(2).max(16).optional(),
    provider: z.enum(['elevenlabs', 'openai']).optional(),
    speakers: z.boolean().optional(),
    text: z.string().trim().min(1).max(40_000).optional(),
    voice: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,100}$/)
      .optional(),
    at: z.number().finite().min(0).default(0),
    seconds: z.number().finite().positive().max(600).optional(),
    max_cost: z.number().finite().nonnegative().optional(),
  })
  .strict()
export type SpeechRequest = z.infer<typeof speechRequestSchema>

/** Curated rows remain descriptive until a signed release or pinned HF
 * manifest supplies exact sizes and hashes. Never download a mutable ref. */
export function installableEntry(entry: CatalogEntry): boolean {
  return (
    entry.source.type === 'hf' &&
    /^[0-9a-f]{40}$/.test(entry.source.commit) &&
    entry.files.length > 0 &&
    entry.files.every(
      (file) =>
        /^[a-zA-Z0-9_.-]+$/.test(file.path) &&
        Number.isSafeInteger(file.bytes) &&
        file.bytes > 0 &&
        /^[0-9a-f]{64}$/.test(file.sha256),
    )
  )
}
