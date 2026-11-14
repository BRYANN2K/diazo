import type { Meta, StoryObj } from '@storybook/react-vite'
import type { LibraryItemSummary, LibraryListEntry } from '../../shared/library'
import { LibraryTile } from '@/components/library/LibraryTile'
import { ItemThumb } from '@/components/library/ItemThumb'
import { LibraryItemTile } from '@/components/library/LibraryItemTile'
import { LibraryFacets } from '@/components/library/LibraryFacets'

const item = (id: string): LibraryItemSummary => ({
  id,
  parentId: null,
  label: id,
  kind: 'cp',
  source: 'scb',
  category: 'Inputs & forms',
  tags: [],
  status: 'active',
  mode: 'snapshot',
  frameId: 'missing',
  pageId: 'p1',
  locator: { whole: true },
  box: null,
  scripted: false,
  rev: 1,
  thumb: '',
})

const library: LibraryListEntry = {
  id: 'lib1',
  name: 'Design Library',
  library: { description: '', visibility: 'private', items: 1278, variants: 4134, index: null, rulesVersion: 1 },
  role: 'manage',
  workspaceId: null,
  listed: false,
}

const meta = { title: 'Library/Tile', component: LibraryTile } satisfies Meta<typeof LibraryTile>
export default meta
type Story = StoryObj<typeof meta>

/** A library on the Libraries page: four items as the cover. */
export const Default: Story = {
  args: { library, onOpen: () => {}, covers: ['cp.a', 'cp.b', 'cp.c', 'cp.d'].map(item) },
  render: (args) => (
    <div className="w-72 p-6">
      <LibraryTile {...args} />
    </div>
  ),
}

/** An item image: its own thumbnail, else the frame preview cropped, else the empty well. */
export const Thumb: StoryObj = {
  render: () => (
    <div className="h-40 w-60 overflow-hidden rounded-card bg-sub">
      <ItemThumb item={item('cp.scb-otp-input')} />
    </div>
  ),
}

/** One family in the gallery, with its variant count and, for a curator, its status. */
export const ItemTile: StoryObj = {
  render: () => (
    <div className="w-60 p-6">
      <LibraryItemTile
        item={{ ...item('cp.scb-otp-input'), status: 'draft' }}
        variantCount={6}
        curator
        live={false}
        onHover={() => {}}
        onOpen={() => {}}
      />
    </div>
  ),
}

/** The gallery's filters: kinds, then categories with their counts. */
export const Facets: StoryObj = {
  render: () => (
    <div className="p-6">
      <LibraryFacets
        kinds={[
          { value: 'cp', label: 'Components', count: 1738 },
          { value: 'bk', label: 'Blocks', count: 652 },
        ]}
        categories={[
          { value: 'Inputs & forms', label: 'Inputs & forms', count: 210 },
          { value: 'Auth', label: 'Auth', count: 48 },
        ]}
        kind=""
        category="Auth"
        onKind={() => {}}
        onCategory={() => {}}
      />
    </div>
  ),
}
