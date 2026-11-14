import { describe, expect, it } from 'vitest'
import { effectiveItem, familyOf, type LibraryItem, type LibraryItemMeta } from '../shared/library'
import { syntheticItems } from './libraryFixtures'

const item = (over: Partial<LibraryItem> = {}): LibraryItem => ({ ...syntheticItems(1)[0]!, ...over })

const meta = (over: Partial<LibraryItemMeta> = {}): LibraryItemMeta => ({
  canvasId: 'lib1',
  itemId: 'x',
  label: null,
  description: null,
  category: null,
  tags: null,
  status: null,
  useCount: 0,
  lastUsedAt: null,
  updatedAt: 1,
  updatedBy: null,
  ...over,
})

describe('effectiveItem', () => {
  it('prefers what people curated', () => {
    const it0 = item({ label: 'Indexed', category: 'Unsorted', tags: ['a'] })
    const out = effectiveItem(it0, meta({ label: 'Curated', category: 'Auth/Log in', tags: ['dark'], useCount: 4 }))
    expect(out).toMatchObject({ label: 'Curated', category: 'Auth/Log in', tags: ['dark'], useCount: 4 })
  })

  it('falls through on a null field', () => {
    const it0 = item({ label: 'Indexed', description: 'From the sheet' })
    expect(effectiveItem(it0, meta({ category: 'Auth' }))).toMatchObject({
      label: 'Indexed',
      description: 'From the sheet',
      category: 'Auth',
    })
    expect(effectiveItem(it0, null)).toBe(it0)
  })

  it('accepts a draft with status active', () => {
    expect(effectiveItem(item({ status: 'draft' }), meta({ status: 'active' })).status).toBe('active')
    expect(effectiveItem(item({ status: 'draft' }), meta()).status).toBe('draft')
    expect(effectiveItem(item({ status: 'active' }), meta({ status: 'hidden' })).status).toBe('hidden')
  })
})

describe('familyOf', () => {
  it('nests variants under their family in frame order', () => {
    const fam = item({ itemId: 'bk.scb-login', parentId: null })
    const v2 = item({ itemId: 'bk.scb-login-b', parentId: 'bk.scb-login', position: 1 })
    const v1 = item({ itemId: 'bk.scb-login-a', parentId: 'bk.scb-login', position: 0 })
    const orphan = item({ itemId: 'cp.x-y', parentId: 'cp.x' })
    const out = familyOf([v2, fam, v1, orphan])
    expect(out.map((f) => [f.family.itemId, f.variants.map((v) => v.itemId)])).toEqual([
      ['bk.scb-login', ['bk.scb-login-a', 'bk.scb-login-b']],
      ['cp.x-y', []],
    ])
  })
})
