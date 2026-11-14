/** A recorded library search for "otp", for the ⌘F tests. */
import type { LibraryItemSummary, LibrarySearchResult } from '../shared/library'

export const summary = (id: string, over: Partial<LibraryItemSummary> = {}): LibraryItemSummary => ({
  id,
  parentId: null,
  label: id,
  kind: id.split('.')[0] ?? '',
  source: 'scb',
  category: 'Inputs & forms',
  tags: [],
  status: 'active',
  mode: 'snapshot',
  frameId: 'sheet',
  pageId: 'p1',
  locator: { whole: true },
  box: null,
  scripted: false,
  rev: 1,
  thumb: '/i/sheet.jpg?preview',
  ...over,
})

export const OTP_RESULT: LibrarySearchResult = {
  hits: [
    {
      libraryId: 'lib1',
      libraryName: 'Design Library',
      item: summary('cp.scb-otp-input', { label: 'OTP input' }),
      variants: ['dark', 'six', 'split'].map((v) =>
        summary(`cp.scb-otp-input-${v}`, {
          parentId: 'cp.scb-otp-input',
          locator: { anchor: `cp.scb-otp-input-${v}` },
        }),
      ),
      variantCount: 3,
      score: 1400,
    },
    {
      libraryId: 'lib1',
      libraryName: 'Design Library',
      item: summary('rs.shadcnblocks', { kind: 'rs', frameId: 'res' }),
      variants: [],
      variantCount: 0,
      score: 20,
    },
  ],
  total: 2,
  facets: { kind: [{ value: 'cp', label: 'cp', count: 1 }], category: [], source: [], tag: [] },
}
