import { describe, expect, it } from 'vitest'
import { isInsertable, itemCanvasUrl, libraryFocus, libraryRows } from '../src/lib/findLibrary'
import { resultRows, rowItem } from '../src/lib/findRows'
import { OTP_RESULT } from './libraryFindFixtures'

describe('libraryRows', () => {
  it('turns a search into family rows with their variant rows', () => {
    const groups = libraryRows(OTP_RESULT)
    expect(groups.map((g) => [g.key, g.id, g.variantCount, g.canvasName])).toEqual([
      ['lib1:cp.scb-otp-input', 'cp.scb-otp-input', 3, 'Design Library'],
      ['lib1:rs.shadcnblocks', 'rs.shadcnblocks', 0, 'Design Library'],
    ])
    const rows = resultRows(groups, new Set(['lib1:cp.scb-otp-input']))
    expect(rows.map((r) => rowItem(r)?.id)).toEqual([
      'cp.scb-otp-input',
      'cp.scb-otp-input-dark',
      'cp.scb-otp-input-six',
      'cp.scb-otp-input-split',
      'rs.shadcnblocks',
    ])
  })

  it('frames a variant on its own anchor, a family on its first matched variant', () => {
    const rows = resultRows(libraryRows(OTP_RESULT), new Set(['lib1:cp.scb-otp-input']))
    expect(libraryFocus(rows[2]!)).toBe('cp.scb-otp-input-six')
    expect(libraryFocus(rows[0]!)).toBe('cp.scb-otp-input-dark')
    expect(libraryFocus(rows[4]!)).toBe('rs.shadcnblocks')
  })

  it('does not insert a non-insertable kind', () => {
    expect(isInsertable(OTP_RESULT.hits[0]!.item)).toBe(true)
    expect(isInsertable(OTP_RESULT.hits[1]!.item)).toBe(false)
    expect(itemCanvasUrl('lib1', OTP_RESULT.hits[1]!.item)).toBe('/c/lib1?frame=res')
  })
})
