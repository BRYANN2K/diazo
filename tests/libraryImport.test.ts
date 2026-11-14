import { describe, expect, it } from 'vitest'
import { EMPTY_TAXONOMY } from '../shared/library'
import { RULE_PRESETS, type LibraryRules } from '../shared/libraryRules'
import { planImport, type ImportFrame, type ImportLibrary } from '../server/libraryImportPlan'
import { FIXTURE_FRAMES, fixture } from './libraryFixtures'

const rules = (patch: (r: LibraryRules) => void = () => {}): LibraryRules => {
  const r = structuredClone(RULE_PRESETS.sheets)
  patch(r)
  return r
}

const library = (over: Partial<ImportLibrary> = {}): ImportLibrary => ({
  canvasId: 'lib1',
  rules: rules(),
  taxonomy: EMPTY_TAXONOMY,
  pages: [
    { id: 'p1', name: 'Everything' },
    { id: 'pa', name: 'Auth' },
  ],
  frames: [
    { pageId: 'pa', x: 100, y: 0, width: 800, height: 400 },
    { pageId: 'pa', x: 100, y: 500, width: 800, height: 300 },
  ],
  currentPageId: 'p1',
  ...over,
})

const frame = (over: Partial<ImportFrame>): ImportFrame => ({
  frameId: 'f',
  name: 'Frame',
  html: '<!doctype html><html><body><p>x</p></body></html>',
  width: 800,
  height: 600,
  ...over,
})

const PLAIN = frame({
  frameId: 'a',
  name: 'Login screen',
  html: '<!doctype html><html><body><p>Log in</p></body></html>',
})

describe('ids', () => {
  it('assigns kind.slug from the default kind', () => {
    const r = planImport({
      library: library({ rules: rules((x) => ((x.ids.pattern = 'kind.slug'), (x.ids.defaultKind = 'cp'))) }),
      frames: [PLAIN],
      existing: [],
    })
    expect(r.frames[0]!.item?.itemId).toBe('cp.login-screen')
    expect(r.frames[0]!.changes.name).toBe('cp.login-screen — Login screen')
  })

  it('reports no-id when the rules give no default kind', () => {
    const r = planImport({ library: library(), frames: [PLAIN], existing: [] })
    expect(r.frames[0]!.item).toBeUndefined()
    expect(r.frames[0]!.findings.map((f) => f.kind)).toEqual(['no-id'])
  })

  it('suffixes a second one, or refuses it under reject', () => {
    const lib = (onCollision: 'suffix' | 'reject') =>
      library({
        rules: rules(
          (x) => ((x.ids.pattern = 'kind.slug'), (x.ids.defaultKind = 'cp'), (x.ids.onCollision = onCollision)),
        ),
      })
    const existing = [{ itemId: 'cp.login-screen', hash: 'h', frameId: 'old' }]
    const suffixed = planImport({ library: lib('suffix'), frames: [PLAIN], existing })
    expect(suffixed.frames[0]!.item?.itemId).toBe('cp.login-screen-2')
    const refused = planImport({ library: lib('reject'), frames: [PLAIN], existing })
    expect(refused.frames[0]!.item).toBeUndefined()
    expect(refused.frames[0]!.findings.map((f) => f.kind)).toEqual(['id-collision'])
  })
})

describe('dependencies', () => {
  const card = frame({
    frameId: 'card',
    name: 'cp.scb-login-button-passkey — Passkey',
    html: '<!doctype html><html><body><span>Sign in<svg><use href="#key"></use></svg></span></body></html>',
  })
  const sheet = frame({ frameId: 'sheet', name: FIXTURE_FRAMES['sheet-static'].name, html: fixture('sheet-static') })

  it('reports a symbol nothing brings', () => {
    const r = planImport({ library: library(), frames: [card], existing: [] })
    expect(r.frames[0]!.findings).toEqual([expect.objectContaining({ kind: 'missing-dependency', refs: ['key'] })])
  })

  it('copies it in from a frame of the same import', () => {
    const r = planImport({ library: library(), frames: [sheet, card], existing: [] })
    const report = r.frames[1]!
    expect(report.findings.some((f) => f.kind === 'missing-dependency')).toBe(false)
    expect(report.changes.html).toContain('<symbol id="key"')
  })
})

describe('variants and markers', () => {
  it('marks the sheet’s variants and family so they keep their ids', () => {
    const sheet = frame({ frameId: 'sheet', name: FIXTURE_FRAMES['sheet-static'].name, html: fixture('sheet-static') })
    const r = planImport({ library: library(), frames: [sheet], existing: [] })
    expect(r.frames[0]!.variants).toEqual([
      'bk.scb-login-minimal-email-password',
      'bk.scb-login-social-with-email-option',
    ])
    expect(r.frames[0]!.changes.html).toContain('data-doop-variant="bk.scb-login-social-with-email-option"')
    expect(r.frames[0]!.changes.html).toContain('<body data-doop-item="bk.scb-login">')
  })
})

describe('duplicates', () => {
  it('flags two frames with the same content', () => {
    const a = frame({
      frameId: 'a',
      name: 'cp.x-one — One',
      html: '<!doctype html><html><body><p>Same</p></body></html>',
    })
    const b = frame({
      frameId: 'b',
      name: 'cp.x-two — Two',
      html: '<!doctype html><html><body><p>Same</p></body></html>',
    })
    const r = planImport({ library: library(), frames: [a, b], existing: [] })
    expect(r.frames[1]!.findings.map((f) => f.kind)).toContain('duplicate')
    expect(r.frames[1]!.item?.status).toBe('draft')
  })
})

describe('categories', () => {
  it('takes marker over section over page over kind', () => {
    const marked = '<!doctype html><html><body data-doop-category="Marked"><p>m</p></body></html>'
    const base = { name: 'bk.scb-thing — Thing', pageName: '013 Inputs & forms · Checkboxes', section: 'Inputs/Text' }
    const cat = (f: Partial<ImportFrame>) =>
      planImport({ library: library(), frames: [frame({ ...base, ...f })], existing: [] }).frames[0]!.item?.category
    expect(cat({ html: marked })).toBe('Marked')
    expect(cat({})).toBe('Inputs/Text')
    expect(cat({ section: null })).toBe('Inputs & forms')
    expect(cat({ section: null, pageName: undefined })).toBe('Blocks')
  })
})

describe('placement', () => {
  it('appends below the last frame of the category’s page, and creates a missing page', () => {
    const inAuth = frame({ frameId: 'a', name: 'bk.scb-login — Login', section: 'Auth/Log in', height: 200 })
    const second = frame({ frameId: 'b', name: 'bk.scb-signup — Sign up', section: 'Auth/Sign up', height: 100 })
    const elsewhere = frame({ frameId: 'c', name: 'bk.scb-table — Table', section: 'Data/Tables' })
    const r = planImport({ library: library(), frames: [inAuth, second, elsewhere], existing: [] })
    expect(r.frames[0]!.changes).toMatchObject({ pageId: 'pa', x: 100, y: 880 })
    expect(r.frames[1]!.changes).toMatchObject({ pageId: 'pa', y: 880 + 200 + 80 })
    expect(r.frames[2]!.changes).toMatchObject({ newPage: 'Data', y: 0 })
  })

  it('places ignored frames without an item', () => {
    const r = planImport({ library: library(), frames: [frame({ name: '§ Auth A — Log in' })], existing: [] })
    expect(r.frames[0]!.ignored).toBe(true)
    expect(r.frames[0]!.item).toBeUndefined()
    expect(r.totals).toMatchObject({ frames: 1, items: 0, ignored: 1 })
  })
})
