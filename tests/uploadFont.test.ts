import { beforeEach, expect, it, vi } from 'vitest'
import { MAX_FONT_BYTES, type CustomFont } from '../shared/fonts.ts'

/* upload_font's source_url path: the server fetches the file through the
   same SSRF-pinned fetch upload_asset uses, at the font size cap, and hands
   the bytes to the font library pipeline. Both ends are stubbed here; the
   real pipeline is covered over HTTP in uploadFontHttp.test.ts. */

const fetchRemote = vi.fn<(url: string, maxBytes?: number) => Promise<Buffer>>()
const addFont = vi.fn()

vi.mock('../server/assets.ts', () => ({ fetchRemote, createUploadTicket: vi.fn() }))
vi.mock('../server/fonts.ts', () => ({
  addFont,
  canUseScope: (scope: { workspaceId?: string }, userId: string) => !scope.workspaceId || userId === 'member',
  FontInputError: class extends Error {},
}))

const { runUploadFont } = await import('../server/fontUpload.ts')

const font: CustomFont = {
  id: 'f1',
  family: 'Remote Mono',
  weight: '100 900',
  style: 'normal',
  format: 'woff2',
  url: 'http://doop.test/a/abc.woff2',
  fileName: 'RemoteMono.woff2',
  size: 4,
  createdAt: 0,
}

beforeEach(() => {
  fetchRemote.mockReset().mockResolvedValue(Buffer.from('wOF2'))
  addFont.mockReset().mockResolvedValue(font)
})

it('fetches source_url at the font cap and adds it to the canvas workspace library', async () => {
  const outcome = await runUploadFont(
    { canvas_id: 'c1', source_url: 'https://fonts.example/files/Remote%20Mono.woff2' },
    { user: { id: 'member', name: 'Member' }, canvasFor: () => ({ workspaceId: 'ws1', ownerId: 'someone' }) },
  )
  expect(fetchRemote).toHaveBeenCalledWith('https://fonts.example/files/Remote%20Mono.woff2', MAX_FONT_BYTES)
  expect(addFont).toHaveBeenCalledWith(
    { workspaceId: 'ws1' },
    { id: 'member', name: 'Member' },
    Buffer.from('wOF2'),
    'Remote Mono.woff2',
  )
  expect(outcome).toMatchObject({
    ok: true,
    data: { family: 'Remote Mono', weight: '100 900', css: 'font-family: "Remote Mono", sans-serif;' },
  })
})

it('reports a failed fetch and adds nothing', async () => {
  fetchRemote.mockRejectedValue(new Error('file exceeds the 10 MB limit'))
  const outcome = await runUploadFont(
    { canvas_id: 'c1', source_url: 'https://fonts.example/huge.ttf' },
    { user: { id: 'owner', name: 'Owner' }, canvasFor: () => ({ ownerId: 'owner' }) },
  )
  expect(outcome).toEqual({ ok: false, error: 'file exceeds the 10 MB limit' })
  expect(addFont).not.toHaveBeenCalled()
})

it('needs a signed-in account and a canvas it can edit', async () => {
  const anonymous = await runUploadFont({ canvas_id: 'c1', data: 'AAAA' }, { canvasFor: () => ({ ownerId: 'x' }) })
  expect(anonymous.ok).toBe(false)
  const hidden = await runUploadFont(
    { canvas_id: 'c1', data: 'AAAA' },
    { user: { id: 'owner', name: 'Owner' }, canvasFor: () => undefined },
  )
  expect(hidden).toMatchObject({ ok: false, error: expect.stringContaining('no canvas with id c1') })
  expect(addFont).not.toHaveBeenCalled()
})
