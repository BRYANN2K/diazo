// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_PARKED_CHARS,
  clearComposerDraft,
  flushComposerDrafts,
  pruneComposerDrafts,
  purgeComposerDrafts,
  readComposerDraft,
  setComposerDraftOwner,
  writeComposerDraft,
} from '../src/lib/composerDrafts'

/**
 * The composer's parked drafts: one `doop:composer-draft:<userId>:<canvasId>`
 * key per account and canvas, written on a debounce, cleared the moment the
 * card queues, pruned by age and count so the scratchpad never becomes an
 * archive, and removed when the account signs out or another one signs in.
 */

const KEY = (id: string, user = 'u1') => `doop:composer-draft:${user}:${id}`
const DAY_MS = 24 * 60 * 60 * 1000

function park(id: string, text: string, at: number, user = 'u1') {
  localStorage.setItem(KEY(id, user), JSON.stringify({ text, at }))
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
  setComposerDraftOwner('u1')
})

afterEach(() => {
  /* land (then drop) anything still inside a debounce window, and hand the
     real clock back — several tests swap it for a fake one */
  flushComposerDrafts()
  localStorage.clear()
  /* back to signed out, so the next test's owner is a change */
  setComposerDraftOwner(null)
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

describe('the composer draft owner', () => {
  it('scopes the draft to the signed-in account', () => {
    park('c1', 'alice was here', Date.now())
    expect(readComposerDraft('c1')).toBe('alice was here')
    /* another account reads nothing, and its arrival removes the other's */
    setComposerDraftOwner('u2')
    expect(readComposerDraft('c1')).toBeNull()
    expect(localStorage.getItem(KEY('c1'))).toBeNull()
  })

  it('parks nothing while signed out', () => {
    setComposerDraftOwner(null)
    writeComposerDraft('c1', 'nobody owns this')
    flushComposerDrafts()
    expect(parkedKeys()).toEqual([])
    expect(readComposerDraft('c1')).toBeNull()
  })

  it('purges every draft when the session ends', () => {
    vi.useFakeTimers()
    park('c1', 'parked', Date.now())
    park('c2', 'other account', Date.now(), 'u9')
    writeComposerDraft('c3', 'still in the window')
    setComposerDraftOwner(null)
    vi.advanceTimersByTime(1000)
    expect(parkedKeys()).toEqual([])
  })

  it('purges every draft, any account, on sign-out', () => {
    vi.useFakeTimers()
    park('c1', 'mine', Date.now())
    park('c1', 'theirs', Date.now(), 'u9')
    localStorage.setItem('doop:layers-open', '1')
    writeComposerDraft('c2', 'still in the window')
    purgeComposerDrafts()
    vi.advanceTimersByTime(1000)
    expect(parkedKeys()).toEqual([])
    expect(localStorage.getItem('doop:layers-open')).toBe('1')
  })

  it("keeps the same account's drafts when it is set again", () => {
    park('c1', 'mine', Date.now())
    expect(setComposerDraftOwner('u1')).toBe(false)
    expect(readComposerDraft('c1')).toBe('mine')
  })

  it('drops drafts parked before the key carried an account', () => {
    localStorage.setItem('doop:composer-draft:c1', JSON.stringify({ text: 'unscoped', at: Date.now() }))
    pruneComposerDrafts()
    expect(localStorage.getItem('doop:composer-draft:c1')).toBeNull()
  })
})

describe('the composer draft limits', () => {
  it('does not park a draft past the length cap, and drops the shorter copy', () => {
    vi.useFakeTimers()
    park('c1', 'short', Date.now())
    writeComposerDraft('c1', 'x'.repeat(MAX_PARKED_CHARS + 1))
    vi.advanceTimersByTime(400)
    expect(localStorage.getItem(KEY('c1'))).toBeNull()
    writeComposerDraft('c1', 'x'.repeat(MAX_PARKED_CHARS))
    vi.advanceTimersByTime(400)
    expect(readComposerDraft('c1')).toHaveLength(MAX_PARKED_CHARS)
  })

  it('prunes before writing, so a full storage gets room back', () => {
    vi.useFakeTimers()
    park('expired', 'old', Date.now() - 31 * DAY_MS)
    /* a storage that refuses every write while the expired entry is there */
    const setItem = Storage.prototype.setItem
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (this.getItem(KEY('expired')) !== null) throw new DOMException('full', 'QuotaExceededError')
      setItem.call(this, key, value)
    })
    writeComposerDraft('c1', 'fits now')
    vi.advanceTimersByTime(400)
    spy.mockRestore()
    expect(readComposerDraft('c1')).toBe('fits now')
  })
})
