import { describe, expect, it } from 'vitest'
import {
  captionsFromTranscript,
  cutWords,
  duckingKeyframes,
  findFillers,
  parseMediaBody,
  parseTranscript,
  snapToBeat,
} from '../shared/motionMedia.ts'

const words = [
  { text: 'Bonjour', start: 0.5, end: 0.9, speaker: 'S1' },
  { text: 'euh', start: 0.9, end: 1.1, speaker: 'S1' },
  { text: 'le', start: 1.8, end: 1.95, speaker: 'S1' },
  { text: 'monde', start: 1.95, end: 2.3, speaker: 'S1' },
  { text: 'ici', start: 2.4, end: 2.7, speaker: 'S2' },
]

describe('parseMediaBody', () => {
  it('accepts a full media row', () => {
    const body = parseMediaBody({
      kind: 'video',
      trimIn: 1.5,
      trimOut: 42,
      cuts: [{ start: 3, end: 4 }],
      beats: { markers: [0.5, 1], bpm: 120 },
      transcript: { language: 'fr', words },
      generation: { provider: 'openrouter', model: 'veo', prompt: 'a duck', seed: 3, cost: 0.4 },
    })
    expect(body?.kind).toBe('video')
    expect(body?.cuts).toEqual([{ start: 3, end: 4 }])
    expect(body?.transcript?.words).toHaveLength(5)
  })

  it('rejects bad kinds, inverted trims and cuts', () => {
    expect(parseMediaBody({ kind: 'gif' })).toBeNull()
    expect(parseMediaBody({ kind: 'video', trimIn: 5, trimOut: 4 })).toBeNull()
    expect(parseMediaBody({ kind: 'video', cuts: [{ start: 4, end: 4 }] })).toBeNull()
  })

  it('defaults trimIn 0 and trimOut null', () => {
    const body = parseMediaBody({ kind: 'audio' })
    expect(body?.trimIn).toBe(0)
    expect(body?.trimOut).toBeNull()
  })
})

describe('parseTranscript', () => {
  it('keeps speakers and engine metadata', () => {
    const t = parseTranscript({
      language: 'fr',
      words,
      speakers: { S1: 'Bryan', S2: 'Guest' },
      engine: 'sherpa-onnx',
      model: 'parakeet-tdt-0.6b-v3',
      target: 'desktop',
    })
    expect(t?.speakers?.S2).toBe('Guest')
    expect(t?.engine).toBe('sherpa-onnx')
  })

  it('rejects malformed words', () => {
    expect(parseTranscript({ language: 'fr', words: [{ text: '', start: 0, end: 1 }] })).toBeNull()
    expect(parseTranscript({ language: 'fr', words: [{ text: 'x', start: 2, end: 1 }] })).toBeNull()
  })
})

describe('cutWords (transcript editing)', () => {
  it('drops words overlapping a cut range', () => {
    const kept = cutWords(words, [{ start: 0.91, end: 1.2 }])
    expect(kept.map((w) => w.text)).toEqual(['Bonjour', 'le', 'monde', 'ici'])
  })
})

describe('findFillers', () => {
  it('finds filler words and long silences', () => {
    const { wordRanges, silenceRanges } = findFillers(words, 0.3)
    expect(wordRanges).toEqual([{ start: 0.9, end: 1.1 }])
    expect(silenceRanges).toEqual([{ start: 1.1, end: 1.8 }])
  })
})

describe('captionsFromTranscript', () => {
  it('chunks words into caption clips with word timings', () => {
    const clips = captionsFromTranscript({ language: 'fr', words }, { maxWords: 3 })
    expect(clips.length).toBeGreaterThanOrEqual(2)
    const first = clips[0]!
    expect(first.source.type).toBe('caption')
    if (first.source.type === 'caption') {
      expect(first.source.words).toHaveLength(3)
      expect(first.source.text).toBe('Bonjour euh le')
    }
    expect(first.start).toBe(0.5)
    expect(first.duration).toBeCloseTo(1.45)
  })

  it('breaks on a speaker change', () => {
    const clips = captionsFromTranscript({ language: 'fr', words }, { maxWords: 10 })
    const last = clips[clips.length - 1]!
    if (last.source.type === 'caption') expect(last.source.text).toBe('ici')
  })
})

describe('duckingKeyframes', () => {
  it('writes hold+linear gain keyframes around each voice range', () => {
    const kfs = duckingKeyframes([{ start: 2, end: 5 }], { depth: 0.2, attack: 0.1, release: 0.5 })
    expect(kfs.map((k) => [k.t, k.value])).toEqual([
      [0, 1],
      [1.9, 1],
      [2, 0.2],
      [5, 0.2],
      [5.5, 1],
    ])
  })

  it('clamps the first ramp at 0', () => {
    const kfs = duckingKeyframes([{ start: 0.05, end: 1 }])
    expect(kfs[1]!.t).toBe(0)
  })
})

describe('snapToBeat', () => {
  it('snaps within tolerance only', () => {
    const beats = { markers: [0.5, 1, 1.5], bpm: 120 }
    expect(snapToBeat(1.02, beats)).toBe(1)
    expect(snapToBeat(1.2, beats)).toBe(1.2)
  })
})
