import { describe, expect, it } from 'vitest'
import type { CanvasFindHit } from '../shared/canvasFind'
import { defaultFocus, focusOf, groupByFrame, resultRows, rowDomId, rowKey, variantIds } from '../src/lib/findRows'

const hit = (over: Partial<CanvasFindHit>): CanvasFindHit => ({
  frameId: 'f',
  pageId: 'p1',
  pageName: 'Page 1',
  frameName: 'Frame',
  where: 'text',
  n: 0,
  before: '',
  text: 'otp',
  after: '',
  ...over,
})

/* recorded from a search for "otp" on a library canvas */
const HITS: CanvasFindHit[] = [
  hit({
    frameId: 'sec',
    frameName: '§ Inputs A — Text fields & core inputs',
    where: 'text',
    before: 'codes and ',
    after: ' fields',
  }),
  hit({ frameId: 'mention', frameName: 'Settings page', where: 'text', before: 'enter the ', after: ' sent by sms' }),
  hit({
    frameId: 'sheet',
    frameName: 'cp.scb-otp — shadcnblocks · OTP (3)',
    where: 'name',
    n: -1,
    before: 'cp.scb-',
    after: '',
  }),
  hit({
    frameId: 'sheet',
    frameName: 'cp.scb-otp — shadcnblocks · OTP (3)',
    n: 0,
    before: 'cp.scb-',
    after: '-input-dark · dark',
  }),
  hit({
    frameId: 'sheet',
    frameName: 'cp.scb-otp — shadcnblocks · OTP (3)',
    n: 1,
    before: 'cp.scb-',
    after: '-input-six · six',
  }),
  hit({
    frameId: 'sheet',
    frameName: 'cp.scb-otp — shadcnblocks · OTP (3)',
    n: 2,
    before: 'cp.scb-',
    after: '-input-six · again',
  }),
  hit({
    frameId: 'card',
    frameName: 'cp.scb-otp-input-split — Split boxes',
    where: 'name',
    n: -1,
    before: 'cp.scb-',
    after: '-input-split',
  }),
]

describe('groupByFrame', () => {
  const groups = groupByFrame(HITS, 'otp')

  it('ranks the frame named for the term first, section headers last', () => {
    expect(groups.map((g) => g.frameId)).toEqual(['sheet', 'card', 'mention', 'sec'])
  })

  it('splits the frame name and lists the distinct variants found inside', () => {
    const sheet = groups[0]!
    expect(sheet).toMatchObject({ id: 'cp.scb-otp', label: 'shadcnblocks · OTP (3)', pageName: 'Page 1' })
    expect(sheet.hits).toHaveLength(4)
    expect(sheet.inside.map((x) => x.label)).toEqual(['cp.scb-otp-input-dark', 'cp.scb-otp-input-six'])
    expect(variantIds(sheet).map((x) => x.label)).toEqual(['cp.scb-otp-input-dark', 'cp.scb-otp-input-six'])
  })

  it('keeps a passing mention as its snippet', () => {
    const mention = groups.find((g) => g.frameId === 'mention')!
    expect(mention.id).toBeNull()
    expect(mention.inside.map((x) => x.label)).toEqual(['enter the otp sent by sms'])
  })
})

describe('rows and focus', () => {
  const groups = groupByFrame(HITS, 'otp')

  it('lists each frame, then its variants when expanded', () => {
    const rows = resultRows(groups, new Set(['sheet']))
    expect(rows.map((r) => r.key)).toEqual([
      'sheet',
      'sheet\ncp.scb-otp-input-dark',
      'sheet\ncp.scb-otp-input-six',
      'card',
      'mention',
      'sec',
    ])
    expect(rowDomId(rows[1]!.key)).toBe('find-row-sheet_cp_scb-otp-input-dark')
    expect(rowKey(groups[0]!, 'x')).toBe('sheet\nx')
  })

  it('frames a variant row on its id, a frame row on its first variant or its own id', () => {
    const rows = resultRows(groups, new Set(['sheet']))
    expect(focusOf(rows[1]!, 'otp')).toBe('cp.scb-otp-input-dark')
    expect(focusOf(rows[0]!, 'otp')).toBe('cp.scb-otp-input-dark')
    expect(
      defaultFocus(
        groups.find((g) => g.frameId === 'card')!,
        'otp',
      ),
    ).toBe('cp.scb-otp-input-split')
    expect(
      defaultFocus(
        groups.find((g) => g.frameId === 'mention')!,
        ' otp ',
      ),
    ).toBe('otp')
  })
})
