import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_PREFERENCES,
  installableEntry,
  routeTarget,
  SPEECH_CATALOG,
  speechRequestSchema,
} from '../shared/speech.ts'
import {
  charsToWords,
  elevenLabsSpeak,
  openaiTranscribe,
  scribeTranscribe,
  validateCustomModel,
} from '../server/speech.ts'
import { getAccounts } from '../server/modelAccounts.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

vi.mock('../server/db/index.ts', () => ({ db: {} }))
vi.mock('../server/modelAccounts.ts', () => ({ getAccounts: vi.fn() }))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetAllMocks()
  unstubAllEnvs()
})

const keyAccount = (kind: 'openai-key' | 'elevenlabs-key') => ({
  userId: 'u',
  kind,
  enabled: true,
  connectedAt: 1,
  apiKey: 'private-test-key',
})
const custom = {
  kind: 'asr' as const,
  runtime: 'whisper.cpp',
  source: { type: 'hf', repo: 'owner/model', commit: 'a'.repeat(40) },
  files: [{ path: 'model.gguf', bytes: 128, sha256: 'b'.repeat(64) }],
  licenseId: 'MIT',
  licenseAck: true,
}

describe('speech routing and input contract', () => {
  it('selects a different default for each target, never implicit cloud', () => {
    expect(
      routeTarget('auto', 'tts', { desktop: true, server: true }, { desktop: [], server: ['pocket-tts'] }),
    ).toMatchObject({ target: 'server', modelId: 'pocket-tts' })
    expect(routeTarget('auto', 'asr', { desktop: false, server: false }, { desktop: [], server: [] })).toMatchObject({
      target: 'install',
    })
    expect(routeTarget('cloud', 'asr', { desktop: false, server: false }, { desktop: [], server: [] })).toMatchObject({
      target: 'cloud',
    })
  })
  it('does not route to an offline target or substitute a requested model', () => {
    expect(
      routeTarget(
        'desktop',
        'asr',
        { desktop: false, server: true },
        { desktop: ['parakeet-tdt-0.6b-v3'], server: [] },
      ),
    ).toMatchObject({ target: 'install' })
    expect(
      routeTarget(
        'auto',
        'asr',
        { desktop: true, server: true },
        { desktop: ['parakeet-tdt-0.6b-v3'], server: [] },
        'whisper-large-v3',
      ),
    ).toMatchObject({ target: 'install' })
    expect(DEFAULT_PREFERENCES.transcribeTarget).toBe('auto')
    expect(speechRequestSchema.parse({ kind: 'transcribe' }).target).toBeUndefined()
  })
  it('rejects unknown parameters, negative costs and path-like voice ids', () => {
    for (const data of [
      { kind: 'speak', voice: '../x' },
      { kind: 'transcribe', max_cost: -1 },
      { kind: 'speak', command: 'run' },
      { kind: 'speak', at: NaN },
    ])
      expect(speechRequestSchema.safeParse(data).success).toBe(false)
  })
  it('keeps unpinned catalog rows unavailable to installers', () => {
    expect(SPEECH_CATALOG.every((entry) => !installableEntry(entry))).toBe(true)
    const entry = {
      ...SPEECH_CATALOG[0]!,
      source: { type: 'hf' as const, repo: 'owner/model', commit: 'a'.repeat(40) },
      files: custom.files,
    }
    expect(installableEntry(entry)).toBe(true)
    expect(installableEntry({ ...entry, files: [{ ...custom.files[0]!, path: '../model.gguf' }] })).toBe(false)
  })
})

describe('custom model validation', () => {
  it('requires closed runtimes, immutable revisions, hashes, safe paths and licence acknowledgement', () => {
    expect(validateCustomModel(custom)).toBeNull()
    for (const change of [
      { runtime: 'shell' },
      { source: { type: 'hf', repo: 'owner/model', commit: 'main' } },
      { licenseAck: false },
      { files: [{ ...custom.files[0], path: '../weights.gguf' }] },
      { files: [{ ...custom.files[0], path: '/tmp/model.gguf' }] },
      { files: [{ ...custom.files[0], bytes: Infinity }] },
      { files: [null] },
      { files: [{ ...custom.files[0], sha256: '' }] },
      { files: [{ ...custom.files[0], path: 'model.pkl' }] },
    ]) {
      expect(validateCustomModel({ ...custom, ...change })).not.toBeNull()
    }
  })
})

describe('cloud adapters on the connected user key', () => {
  it('does not fetch without a connected key or when disabled', async () => {
    vi.mocked(getAccounts).mockResolvedValue([])
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await expect(openaiTranscribe('u', { buf: Buffer.from('a'), name: 'a.wav' }, {})).rejects.toThrow(
      'connect an OpenAI key',
    )
    stubEnv('DOOP_ELEVENLABS', 'false')
    await expect(scribeTranscribe('u', { buf: Buffer.from('a'), name: 'a.wav' }, {})).rejects.toThrow('disabled')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('requests word timestamps and normalizes an OpenAI transcript', async () => {
    vi.mocked(getAccounts).mockResolvedValue([keyAccount('openai-key')])
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        language: 'fr',
        words: [
          { word: 'Bonjour', start: 0, end: 0.6 },
          { word: '', start: 0.6, end: 0.7 },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetcher)
    const result = await openaiTranscribe('u', { buf: Buffer.from('a'), name: 'a.wav' }, { language: 'fr' })
    expect(result).toMatchObject({ provider: 'openai', words: [{ text: 'Bonjour', start: 0, end: 0.6 }] })
    const init = fetcher.mock.calls[0]![1] as RequestInit
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer private-test-key')
    expect((init.body as FormData).get('timestamp_granularities[]')).toBe('word')
    await expect(openaiTranscribe('u', { buf: Buffer.alloc(25 * 1024 * 1024 + 1), name: 'a.wav' }, {})).rejects.toThrow(
      '25 MiB',
    )
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('keeps Scribe speaker labels and requests diarization', async () => {
    vi.mocked(getAccounts).mockResolvedValue([keyAccount('elevenlabs-key')])
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        language_code: 'fr',
        words: [
          { text: 'Salut', start: 0, end: 0.5, speaker_id: 'speaker_1' },
          { text: 'Oui', start: 0.6, end: 1, speaker_id: 'speaker_2' },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetcher)
    const result = await scribeTranscribe(
      'u',
      { buf: Buffer.from('a'), name: 'a.wav' },
      { speakers: true, numSpeakers: 2 },
    )
    expect(result.words.map((word) => word.speaker)).toEqual(['S1', 'S2'])
    const form = fetcher.mock.calls[0]![1].body as FormData
    expect(form.get('diarize')).toBe('true')
    expect(form.get('num_speakers')).toBe('2')
  })
  it('folds character timing into words and refuses unknown voice models', async () => {
    vi.mocked(getAccounts).mockResolvedValue([keyAccount('elevenlabs-key')])
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        audio_base64: Buffer.from('ID3audio').toString('base64'),
        alignment: {
          characters: ['H', 'i', ' ', 't', 'o', 'i'],
          character_start_times_seconds: [0, 0.1, 0.2, 0.3, 0.4, 0.5],
          character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
        },
      }),
    )
    vi.stubGlobal('fetch', fetcher)
    const result = await elevenLabsSpeak('u', { voiceId: 'voice1', text: 'Hi toi' })
    expect(result.transcript.words).toEqual([
      { text: 'Hi', start: 0, end: 0.2 },
      { text: 'toi', start: 0.3, end: 0.6 },
    ])
    await expect(elevenLabsSpeak('u', { voiceId: 'voice1', text: 'Hi', model: 'unlisted' })).rejects.toThrow(
      'unknown voice model',
    )
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(() => charsToWords(['a'], [], [])).toThrow('invalid character alignment')
  })
})
