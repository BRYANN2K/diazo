import { describe, expect, it } from 'vitest'
import { EMPTY_TAXONOMY, type LibraryItem } from '../shared/library'
import { buildIndex, idTokens, parseQuery, searchIndex, tokenize } from '../shared/librarySearch'
import { syntheticItems } from './libraryFixtures'

let n = 0
function item(itemId: string, over: Partial<LibraryItem> = {}): LibraryItem {
  const kind = itemId.includes('.') ? itemId.split('.')[0]! : ''
  return {
    canvasId: 'lib1',
    itemId,
    parentId: null,
    frameId: `f-${itemId}`,
    pageId: 'p1',
    position: n++,
    label: itemId,
    description: '',
    kind,
    source: 'scb',
    category: 'Unsorted',
    tags: [],
    mode: 'snapshot',
    locator: { whole: true },
    box: null,
    scripted: false,
    status: 'active',
    findings: [],
    hash: itemId,
    rev: 1,
    searchText: '',
    sourceUrl: null,
    license: null,
    indexedAt: 1,
    ...over,
  }
}

const otp = [
  item('cp.scb-otp-input', { label: 'OTP input', category: 'Inputs & forms/OTP & code inputs' }),
  item('cp.scb-otp-input-dark', {
    parentId: 'cp.scb-otp-input',
    label: 'OTP input · dark',
    tags: ['dark'],
    category: 'Inputs & forms/OTP & code inputs',
  }),
  item('cp.scb-otp-input-six', {
    parentId: 'cp.scb-otp-input',
    label: 'Six digit OTP',
    category: 'Inputs & forms/OTP & code inputs',
  }),
  item('cp.scb-otp-input-split', {
    parentId: 'cp.scb-otp-input',
    label: 'Split boxes',
    searchText: 'otp code',
    category: 'Inputs & forms/OTP & code inputs',
  }),
]
const login = [
  item('bk.scb-login', { label: 'Login', category: 'Auth/Log in' }),
  item('bk.scb-login-button', { parentId: 'bk.scb-login', label: 'Login button', category: 'Auth/Log in' }),
  item('cp.scb-passkey', { label: 'Sign in with passkey', category: 'Auth/Log in', tags: ['dark'] }),
]
const others = [
  item('cp.scb-mention', { label: 'Mention list', searchText: 'mentions otp in passing' }),
  item('mo.tk-fade', { label: 'Fade up', kind: 'mo', source: 'tk' }),
  item('cp.scb-gone', { label: 'OTP hidden one', status: 'hidden' }),
  item('cp.scb-draft-otp', { label: 'OTP draft', status: 'draft' }),
  item('cp.scb-old-otp', { label: 'OTP old', status: 'deprecated' }),
]
const all = [...otp, ...login, ...others]
const index = buildIndex(all, EMPTY_TAXONOMY)
const ids = (r: ReturnType<typeof searchIndex>) => r.hits.map((h) => h.item.itemId)

describe('tokens and queries', () => {
  it('folds and splits', () => {
    expect(tokenize('Écran · OTP-Input')).toEqual(['ecran', 'otp', 'input'])
    expect(idTokens('cp.scb-otp-input')).toEqual(['cp.scb-otp-input', 'cp', 'scb', 'otp', 'input'])
  })

  it('reads filters out of the query', () => {
    expect(parseQuery('kind:cp in:"Inputs & forms" tag:dark otp')).toEqual({
      terms: ['otp'],
      filters: { kind: ['cp'], category: ['Inputs & forms'], tag: ['dark'] },
      closed: false,
    })
    expect(parseQuery('is:scripted source:scb log ').closed).toBe(true)
  })
})

describe('searchIndex', () => {
  it('puts the otp family first with its variants nested', () => {
    const r = searchIndex(index, 'otp')
    expect(r.hits[0]!.item.itemId).toBe('cp.scb-otp-input')
    expect(r.hits[0]!.variants.map((v) => v.itemId).sort()).toEqual([
      'cp.scb-otp-input-dark',
      'cp.scb-otp-input-six',
      'cp.scb-otp-input-split',
    ])
    expect(r.hits[0]!.variantCount).toBe(3)
    /* variants never appear as their own hit */
    expect(ids(r)).not.toContain('cp.scb-otp-input-dark')
  })

  it('ranks the exact id over a label match', () => {
    const r = searchIndex(index, 'cp.scb-passkey')
    expect(r.hits[0]!.item.itemId).toBe('cp.scb-passkey')
  })

  it('matches the last word as a prefix', () => {
    const r = searchIndex(index, 'log bu')
    expect(ids(r)[0]).toBe('bk.scb-login')
    expect(r.hits[0]!.variants.map((v) => v.itemId)).toEqual(['bk.scb-login-button'])
  })

  it('falls back to OR when AND finds nothing', () => {
    const r = searchIndex(index, 'fade passkey')
    expect(ids(r).sort()).toEqual(['cp.scb-passkey', 'mo.tk-fade'])
  })

  it('tries one edit only when nothing else matches', () => {
    expect(ids(searchIndex(index, 'buton'))).toEqual(['bk.scb-login'])
    const withTypo = buildIndex([...all, item('cp.scb-buton', { label: 'buton' })], EMPTY_TAXONOMY)
    expect(ids(searchIndex(withTypo, 'buton'))).toEqual(['cp.scb-buton'])
  })

  it('filters by kind, category and tag', () => {
    const r = searchIndex(index, 'kind:cp in:"Inputs & forms" tag:dark otp')
    expect(ids(r)).toEqual(['cp.scb-otp-input'])
    expect(r.hits[0]!.variants.map((v) => v.itemId)).toEqual(['cp.scb-otp-input-dark'])
    expect(ids(searchIndex(index, 'source:tk'))).toEqual(['mo.tk-fade'])
    expect(ids(searchIndex(index, 'otp', { filters: { kind: ['mo'] } }))).toEqual([])
  })

  it('counts facets over the whole match set, not the page', () => {
    const r = searchIndex(index, 'otp', { limit: 1 })
    expect(r.hits).toHaveLength(1)
    expect(r.total).toBeGreaterThan(1)
    const cp = r.facets.kind.find((f) => f.value === 'cp')
    expect(cp?.count).toBe(r.total)
    expect(r.facets.category.map((c) => c.value)).toContain('Inputs & forms')
  })

  it('never shows a hidden item, and drafts only when asked', () => {
    expect(ids(searchIndex(index, 'otp'))).not.toContain('cp.scb-gone')
    expect(ids(searchIndex(index, 'otp', { includeDrafts: true }))).not.toContain('cp.scb-gone')
    expect(ids(searchIndex(index, 'otp'))).not.toContain('cp.scb-draft-otp')
    expect(ids(searchIndex(index, 'otp', { includeDrafts: true }))).toContain('cp.scb-draft-otp')
    expect(ids(searchIndex(index, 'is:draft'))).toEqual(['cp.scb-draft-otp'])
  })

  it('sinks a deprecated item', () => {
    const r = ids(searchIndex(index, 'otp'))
    expect(r.at(-1)).toBe('cp.scb-old-otp')
  })

  it('pages with a cursor and no repeats', () => {
    const big = buildIndex(syntheticItems(500), EMPTY_TAXONOMY)
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const r = searchIndex(big, 'card', { limit: 7, cursor })
      seen.push(...ids(r))
      cursor = r.cursor
      pages++
    } while (cursor && pages < 200)
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen.length).toBe(searchIndex(big, 'card').total)
  })

  it('widens the query with a synonym', () => {
    expect(ids(searchIndex(index, 'login'))).not.toContain('cp.scb-passkey')
    expect(ids(searchIndex(index, 'login', { synonyms: { login: ['sign in'] } }))).toContain('cp.scb-passkey')
  })

  it('browses with an empty query, families in order', () => {
    const r = searchIndex(index, '', { limit: 100 })
    expect(ids(r)).toEqual([
      'cp.scb-otp-input',
      'bk.scb-login',
      'cp.scb-passkey',
      'cp.scb-mention',
      'mo.tk-fade',
      'cp.scb-old-otp',
    ])
    expect(searchIndex(index, 'in:Auth').total).toBe(2)
  })

  it('builds 10,000 items in time and answers within budget', () => {
    const items = syntheticItems(10_000)
    const t0 = performance.now()
    const big = buildIndex(items, EMPTY_TAXONOMY)
    const build = performance.now() - t0
    expect(build).toBeLessThan(400 * 3)
    const words = ['login', 'card bu', 'otp', 'kind:cp table', 'in:"Auth/Log in" modal', 'toast dark', 'chart', 'x']
    const times: number[] = []
    for (let i = 0; i < 200; i++) {
      const t = performance.now()
      searchIndex(big, words[i % words.length]!)
      times.push(performance.now() - t)
    }
    times.sort((a, b) => a - b)
    expect(times[Math.floor(times.length * 0.95)]!).toBeLessThan(15 * 3)
  })
})
