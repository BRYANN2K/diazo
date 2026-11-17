import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SPEECH_CATALOG, SPEECH_LIMITS } from '../shared/speech.ts'

/* The desktop shell (desktop/src-tauri/src/speech.rs) and the server
 * registration validator (server/speech.ts) enforce one install contract
 * — the numbers live once in SPEECH_LIMITS and the Rust consts mirror
 * them. These tests hold the two sides equal and check the catalog rows
 * stay inside the contract the shell can install. */
const rs = readFileSync(new URL('../desktop/src-tauri/src/speech.rs', import.meta.url), 'utf8')

const rustConst = (name: string): number => {
  const m = new RegExp(`const ${name}: (?:u64|usize) = ([^;]+);`).exec(rs)
  if (!m) throw new Error(`${name} not found in speech.rs`)
  const shift = /(\d+)\s*<<\s*(\d+)/.exec(m[1]!.trim())
  if (shift) return Number(shift[1]) * 2 ** Number(shift[2])
  return Number(m[1]!.trim())
}

describe('the shared speech contract', () => {
  it('holds the desktop consts equal to SPEECH_LIMITS', () => {
    expect(rustConst('MAX_FILE_BYTES')).toBe(SPEECH_LIMITS.fileBytes)
    expect(rustConst('MAX_MODEL_BYTES')).toBe(SPEECH_LIMITS.modelBytes)
    expect(rustConst('MAX_FILES')).toBe(SPEECH_LIMITS.files)
    expect(rustConst('MAX_NAME')).toBe(SPEECH_LIMITS.name)
  })

  it('allowlists exactly the catalog hf repos in the shell', () => {
    const block = /HF_CATALOG_REPOS[^=]*=\s*&?\[([\s\S]*?)\]/.exec(rs)?.[1] ?? ''
    const repos = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort()
    const catalog = SPEECH_CATALOG.flatMap((e) => (e.source.type === 'hf' ? [e.source.repo] : [])).sort()
    expect(repos).toEqual([...new Set(catalog)])
  })

  it('keeps every catalog file inside the flat-name contract', () => {
    for (const entry of SPEECH_CATALOG) {
      for (const f of entry.files) {
        expect(f.path.length).toBeLessThanOrEqual(SPEECH_LIMITS.name)
        expect(f.path).toMatch(/^[a-zA-Z0-9_.-]+$/)
        expect(f.path.startsWith('.')).toBe(false)
        expect(f.bytes).toBeLessThanOrEqual(SPEECH_LIMITS.fileBytes)
      }
    }
  })

  it('knows the local source both sides share', () => {
    /* server/speech.ts registers { type: 'local' } on the desktop target;
       the shell must parse it — the enum variant is tagged "local" */
    expect(rs).toMatch(/enum SpeechSource[\s\S]*Local,/)
  })
})
