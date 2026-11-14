import type { Meta, StoryObj } from '@storybook/react-vite'
import type { LibraryItemSummary, LibraryListEntry } from '../../shared/library'
import { LibraryTile } from '@/components/library/LibraryTile'
import { ItemThumb } from '@/components/library/ItemThumb'

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
