// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearComposerDraft,
  flushComposerDrafts,
  pruneComposerDrafts,
  readComposerDraft,
  writeComposerDraft,
} from '../src/lib/composerDrafts'

/**
 * The composer's parked drafts: one `doop:composer-draft:<canvasId>` key per
 * canvas, written on a debounce, cleared the moment the card queues, and
 * pruned by age and count so the scratchpad never becomes an archive.
 */

const KEY = (id: string) => `doop:composer-draft:${id}`
const DAY_MS = 24 * 60 * 60 * 1000

function park(id: string, text: string, at: number) {
  localStorage.setItem(KEY(id), JSON.stringify({ text, at }))
}

function parkedKeys(): string[] {
  const keys: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key?.startsWith('doop:composer-draft:')) keys.push(key)
  }
  return keys
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  /* land (then drop) anything still inside a debounce window, and hand the
     real clock back — several tests swap it for a fake one */
  flushComposerDrafts()
  localStorage.clear()
  vi.useRealTimers()
})

describe('the composer draft parking', () => {
  it('writes under a per-canvas key once the debounce passes', () => {
    vi.useFakeTimers()
    writeComposerDraft('c1', 'half a thought')
    expect(localStorage.getItem(KEY('c1'))).toBeNull() // still inside the window
    vi.advanceTimersByTime(400)
    expect(JSON.parse(localStorage.getItem(KEY('c1'))!)).toMatchObject({ text: 'half a thought' })
  })

  it('coalesces keystrokes into one write of the latest text', () => {
    vi.useFakeTimers()
    writeComposerDraft('c1', 'h')
    writeComposerDraft('c1', 'he')
    vi.advanceTimersByTime(399)
    writeComposerDraft('c1', 'hey')
    vi.advanceTimersByTime(400)
    expect(JSON.parse(localStorage.getItem(KEY('c1'))!)).toMatchObject({ text: 'hey' })
  })

  it('reads a write still inside the debounce window', () => {
    vi.useFakeTimers()
    writeComposerDraft('c1', 'unflushed')
    expect(readComposerDraft('c1')).toBe('unflushed')
  })

  it('reads back a parked draft', () => {
    park('c1', 'parked', Date.now())
    expect(readComposerDraft('c1')).toBe('parked')
    expect(readComposerDraft('c2')).toBeNull()
  })

  it('treats malformed, empty and expired entries as absent', () => {
    localStorage.setItem(KEY('bad'), 'not json')
    park('empty', '', Date.now())
    park('old', 'ancient', Date.now() - 31 * DAY_MS)
    expect(readComposerDraft('bad')).toBeNull()
    expect(readComposerDraft('empty')).toBeNull()
    expect(readComposerDraft('old')).toBeNull()
  })

  it('clears at once, including a write still inside the window', () => {
    vi.useFakeTimers()
    writeComposerDraft('c1', 'about to send')
    clearComposerDraft('c1')
    vi.advanceTimersByTime(1000)
    expect(localStorage.getItem(KEY('c1'))).toBeNull()
    expect(readComposerDraft('c1')).toBeNull()
  })

  it('flushes every pending write on demand', () => {
    writeComposerDraft('c1', 'one')
    writeComposerDraft('c2', 'two')
    flushComposerDrafts()
    expect(JSON.parse(localStorage.getItem(KEY('c1'))!)).toMatchObject({ text: 'one' })
    expect(JSON.parse(localStorage.getItem(KEY('c2'))!)).toMatchObject({ text: 'two' })
  })

  it('prunes expired, unreadable and over-cap entries on write', () => {
    vi.useFakeTimers()
    park('expired', 'old', Date.now() - 31 * DAY_MS)
    localStorage.setItem(KEY('junk'), '{oops')
    park('empty', '', Date.now())
    /* fifty-five canvases of parked drafts, c0 newest down to c54 oldest */
    for (let i = 0; i < 55; i++) park(`c${i}`, `draft ${i}`, Date.now() - i * 60_000)
    localStorage.setItem('doop:layers-open', '1') // foreign keys are not ours

    writeComposerDraft('newest', 'fresh')
    vi.advanceTimersByTime(400)

    expect(localStorage.getItem(KEY('expired'))).toBeNull()
    expect(localStorage.getItem(KEY('junk'))).toBeNull()
    expect(localStorage.getItem(KEY('empty'))).toBeNull()
    /* the fifty most recent survive: the new write plus c0…c48 */
    expect(parkedKeys()).toHaveLength(50)
    expect(localStorage.getItem(KEY('newest'))).not.toBeNull()
    expect(localStorage.getItem(KEY('c48'))).not.toBeNull()
    for (const id of ['c49', 'c50', 'c51', 'c52', 'c53', 'c54']) {
      expect(localStorage.getItem(KEY(id))).toBeNull()
    }
    expect(localStorage.getItem('doop:layers-open')).toBe('1')
  })

  it('prunes on demand the same way', () => {
    park('expired', 'old', Date.now() - 31 * DAY_MS)
    park('fresh', 'new', Date.now())
    pruneComposerDrafts()
    expect(localStorage.getItem(KEY('expired'))).toBeNull()
    expect(localStorage.getItem(KEY('fresh'))).not.toBeNull()
  })
})
