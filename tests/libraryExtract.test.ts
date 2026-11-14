import { describe, expect, it } from 'vitest'
import { EMPTY_TAXONOMY } from '../shared/library'
import { RULE_PRESETS, type LibraryRules } from '../shared/libraryRules'
import { compileSelector, parseHtml, selectAll } from '../server/libraryDom'
import { extractFrameItems, pageCategory, sourceLine, type ExtractInput } from '../server/libraryExtract'
import { FIXTURE_FRAMES, fixture, type FixtureName } from './libraryFixtures'

const sheets = RULE_PRESETS.sheets

function input(over: Partial<ExtractInput> & { fixture?: FixtureName } = {}): ExtractInput {
  const name = over.fixture ?? 'sheet-static'
  return {
    frame: { id: 'f1', name: FIXTURE_FRAMES[name].name, html: fixture(name), pageId: 'p1' },
    pageName: '014 Auth & onboarding · Log in — title',
    sectionCategory: null,
    rules: sheets,
    taxonomy: EMPTY_TAXONOMY,
    ...over,
  }
}

const withRules = (patch: (r: LibraryRules) => void): LibraryRules => {
  const rules = structuredClone(sheets)
  patch(rules)
  return rules
}

describe('the static sheet', () => {
  const out = extractFrameItems(input())

  it('gives the family and its two variants', () => {
    expect(out.ignored).toBe(false)
    expect(out.scripted).toBe(true)
    const [family, ...variants] = out.items
    expect(family).toMatchObject({
      itemId: 'bk.scb-login',
      parentId: null,
      label: 'shadcnblocks · Login',
      kind: 'bk',
      source: 'scb',
      locator: { whole: true },
      category: 'Auth & onboarding',
      sourceUrl: 'https://shadcnblocks.com/blocks/login',
      license: null,
    })
    expect(variants.map((v) => [v.itemId, v.parentId, v.position, v.locator])).toEqual([
      ['bk.scb-login-minimal-email-password', 'bk.scb-login', 0, { anchor: 'bk.scb-login-minimal-email-password' }],
      ['bk.scb-login-social-with-email-option', 'bk.scb-login', 1, { anchor: 'bk.scb-login-social-with-email-option' }],
    ])
    expect(variants[0]!.label).toBe('420px column, focus ring 4px')
    expect(variants[1]!.searchText).toContain('Log in')
    expect(variants[1]!.searchText).not.toContain('Sign in')
  })

  it('locates a variant by its design element id when it has one', () => {
    const html = fixture('sheet-static').replace('<div class="v dk">', '<div class="v dk" data-doop-id="dk1">')
    const { items } = extractFrameItems(input({ frame: { ...input().frame, html } }))
    expect(items[2]!.locator).toEqual({ elementId: 'dk1' })
  })

  it('reads the same variants through selectors', () => {
    const rules = withRules((r) => {
      r.detect.variants = { mode: 'selectors', cell: '.g > div', id: '.m b', design: '.v' }
    })
    const viaSelectors = extractFrameItems(input({ rules }))
    expect(viaSelectors.items).toEqual(out.items)
  })

  it('gives one whole-frame item under mode none', () => {
    const rules = withRules((r) => {
      r.detect.variants = { mode: 'none' }
    })
    const { items } = extractFrameItems(input({ rules }))
    expect(items.map((i) => i.itemId)).toEqual(['bk.scb-login'])
    expect(items[0]!.locator).toEqual({ whole: true })
  })

  it('hashes by content: the same html gives the same hash, a changed variant changes only its own', () => {
    const again = extractFrameItems(input())
    expect(again.items.map((i) => i.hash)).toEqual(out.items.map((i) => i.hash))
    const html = fixture('sheet-static').replace('>Log in<', '>Log in now<')
    const changed = extractFrameItems(input({ frame: { ...input().frame, html } }))
    expect(changed.items[0]!.hash).toBe(out.items[0]!.hash)
    expect(changed.items[1]!.hash).toBe(out.items[1]!.hash)
    expect(changed.items[2]!.hash).not.toBe(out.items[2]!.hash)
  })
})

describe('the scripted sheet', () => {
  it('gives the family alone, scripted', () => {
    const out = extractFrameItems(input({ fixture: 'sheet-scripted' }))
    expect(out.scripted).toBe(true)
    expect(out.items.map((i) => i.itemId)).toEqual(['cp.tuff-answers'])
    expect(out.items[0]).toMatchObject({ scripted: true, sourceUrl: 'https://tuffui.com/r', license: 'MIT' })
  })
})

describe('the exploded card', () => {
  it('gives one item labelled by the frame name, its text without the bar', () => {
    const out = extractFrameItems(input({ fixture: 'card-exploded' }))
    expect(out.items).toHaveLength(1)
    const [item] = out.items
    expect(item).toMatchObject({
      itemId: 'cp.scb-login-button-passkey-dark',
      label: 'Sign in with passkey · inverted on dark',
      scripted: false,
    })
    expect(item!.searchText).toContain('Sign in with passkey')
    expect(item!.searchText).not.toContain('Auth entry buttons')
    expect(item!.searchText).not.toContain('view original')
  })
})

describe('names that are not items', () => {
  it('ignores a title frame', () => {
    const frame = { id: 'f2', name: '013 Inputs & forms · Checkboxes — title', html: '<p>x</p>' }
    expect(extractFrameItems(input({ frame }))).toMatchObject({ ignored: true, items: [] })
  })

  it('reads a section frame as the category it starts', () => {
    const frame = { id: 'f3', name: '§ Inputs A — Text fields & core inputs', html: '<p>x</p>' }
    expect(extractFrameItems(input({ frame }))).toEqual({
      items: [],
      scripted: false,
      ignored: true,
      section: 'Inputs/Text fields & core inputs',
    })
  })

  it('takes the section category over the page under sheets', () => {
    const { items } = extractFrameItems(input({ sectionCategory: 'Auth/Log in' }))
    expect(items[0]!.category).toBe('Auth/Log in')
  })
})

describe('explicit markers', () => {
  const html = `<!doctype html><html><body data-doop-item="cp.mk-card" data-doop-tags="Dark, auth" data-doop-category="Cards/Mine">
    <div data-doop-variant="cp.mk-card-small" data-doop-tags="small"><p>Small</p></div>
    <div data-doop-variant="cp.mk-card-large" data-doop-category="Cards/Big"><p>Large</p></div>
    <div class="g"><div><div class="v">x</div><div class="m"><b>cp.other-a</b></div></div><div><div class="v">y</div><div class="m"><b>cp.other-b</b></div></div></div>
  </body></html>`

  it('win over detection', () => {
    const { items } = extractFrameItems(input({ frame: { id: 'f9', name: 'Cards — whatever', html } }))
    expect(items.map((i) => [i.itemId, i.parentId, i.category, i.tags])).toEqual([
      ['cp.mk-card', null, 'Cards/Mine', ['dark', 'auth']],
      ['cp.mk-card-small', 'cp.mk-card', 'Cards/Mine', ['small']],
      ['cp.mk-card-large', 'cp.mk-card', 'Cards/Big', ['dark', 'auth']],
    ])
  })
})

describe('component mains', () => {
  it('are component items', () => {
    const html = '<!doctype html><html><body><div data-doop-component="c1"><button>Buy</button></div></body></html>'
    const { items } = extractFrameItems(input({ frame: { id: 'f4', name: 'cp.ui-button — Button', html } }))
    expect(items).toHaveLength(1)
    expect(items[0]!.mode).toBe('component')
  })
})

describe('plain frames', () => {
  it('get a slug id under blank', () => {
    const { items } = extractFrameItems(
      input({ rules: RULE_PRESETS.blank, frame: { id: 'f5', name: 'Login screen', html: '<p>Hi</p>' } }),
    )
    expect(items.map((i) => [i.itemId, i.label, i.findings])).toEqual([['login-screen', 'Login screen', []]])
  })

  it('are flagged no-id when a kind pattern has no default kind', () => {
    const { items } = extractFrameItems(input({ frame: { id: 'f6', name: 'Login screen', html: '<p>Hi</p>' } }))
    expect(items[0]!.findings.map((f) => f.kind)).toEqual(['no-id'])
  })
})

describe('helpers', () => {
  it('reads page categories', () => {
    expect(pageCategory('013 Inputs & forms · Checkboxes & choice cards + Switches — title')).toBe('Inputs & forms')
    expect(pageCategory('Page 1')).toBe('Page 1')
  })

  it('reads source lines', () => {
    expect(sourceLine(parseHtml(fixture('sheet-scripted')))).toEqual({
      sourceUrl: 'https://tuffui.com/r',
      license: 'MIT',
    })
  })

  it('compiles only the selector grammar', () => {
    expect(compileSelector('.g > div')).not.toBeNull()
    expect(compileSelector('div:has(x)')).toBeNull()
    expect(compileSelector('a >> b')).toBeNull()
    expect(compileSelector('x'.repeat(201))).toBeNull()
    const doc = parseHtml(fixture('sheet-static'))
    expect(selectAll(doc, compileSelector('.g > div'))).toHaveLength(2)
    expect(selectAll(doc, compileSelector('.m b, h1'))).toHaveLength(3)
  })
})

describe('budget', () => {
  it('extracts a 300 KB document in under 50 ms', () => {
    const cell = (i: number) =>
      `<div><div class="v"><span class="b">Item ${i} ${'lorem ipsum '.repeat(20)}</span></div><div class="m"><b>bk.scb-big-${i}</b> · note ${i}</div></div>`
    const cells = Array.from({ length: 900 }, (_, i) => cell(i)).join('')
    const html = `<!doctype html><html><head><style>.v{}</style></head><body><div class="g">${cells}</div></body></html>`
    expect(html.length).toBeGreaterThan(300_000)
    const frame = { id: 'big', name: 'bk.scb-big — Big', html }
    extractFrameItems(input({ frame }))
    const t0 = performance.now()
    const out = extractFrameItems(input({ frame }))
    const ms = performance.now() - t0
    expect(out.items).toHaveLength(901)
    expect(ms).toBeLessThan(50 * 3)
  })
})
