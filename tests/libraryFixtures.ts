/**
 * Ground truth for the design-library tests: three frames reduced from the
 * live libraries, real frame names, and deterministic synthetic items for
 * the 10,000-item budgets.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Canvas, CanvasPageInfo, Frame } from '../shared/types'
import type { LibraryItem } from '../shared/library'

const DIR = join(__dirname, 'fixtures', 'library')

export type FixtureName = 'sheet-static' | 'sheet-scripted' | 'card-exploded'

/** The frame names and sizes the fixtures carry on the live canvases. */
export const FIXTURE_FRAMES: Record<FixtureName, { name: string; width: number; height: number }> = {
  'sheet-static': { name: 'bk.scb-login — shadcnblocks · Login (4)', width: 2040, height: 440 },
  'sheet-scripted': { name: 'cp.tuff-answers — TuffUI · Interactive answers (3)', width: 2040, height: 714 },
  'card-exploded': {
    name: 'cp.scb-login-button-passkey-dark — Sign in with passkey · inverted on dark',
    width: 760,
    height: 560,
  },
}

export function fixture(name: FixtureName): string {
  return readFileSync(join(DIR, `${name}.html`), 'utf8')
}

export function names(): { name: string; id: string | null; label: string }[] {
  return JSON.parse(readFileSync(join(DIR, 'names.json'), 'utf8')) as {
    name: string
    id: string | null
    label: string
  }[]
}

export interface FrameSpec {
  /** a fixture, or literal HTML */
  fixture?: FixtureName
  html?: string
  name?: string
  id?: string
  page?: string
  x?: number
  y?: number
  width?: number
  height?: number
}

/** A canvas with pages and frames built from the fixtures. Frames without a
 *  position are stacked down their page in the order given. */
export function libraryCanvas(
  frames: FrameSpec[],
  opts: { id?: string; name?: string; pages?: CanvasPageInfo[]; ownerId?: string } = {},
): Canvas {
  const canvasId = opts.id ?? 'lib1'
  const pages = opts.pages ?? [{ id: 'p1', name: 'Page 1' }]
  const nextY = new Map<string, number>()
  const built: Frame[] = frames.map((spec, i) => {
    const known = spec.fixture ? FIXTURE_FRAMES[spec.fixture] : null
    const pageId = spec.page ?? pages[0]!.id
    const width = spec.width ?? known?.width ?? 800
    const height = spec.height ?? known?.height ?? 600
    const y = spec.y ?? nextY.get(pageId) ?? 0
    nextY.set(pageId, y + height + 40)
    return {
      id: spec.id ?? `f${i + 1}`,
      canvasId,
      pageId,
      name: spec.name ?? known?.name ?? `Frame ${i + 1}`,
      x: spec.x ?? 0,
      y,
      width,
      height,
      html: spec.html ?? (spec.fixture ? fixture(spec.fixture) : '<!doctype html><html><body></body></html>'),
      createdAt: 1_000 + i,
      updatedAt: 1_000 + i,
      updatedBy: 'test',
    }
  })
  return {
    id: canvasId,
    name: opts.name ?? 'Design Library',
    ownerId: opts.ownerId ?? 'owner',
    createdAt: 1,
    updatedAt: 1,
    frames: built,
    pages,
  }
}

const WORDS = [
  'login',
  'button',
  'card',
  'input',
  'otp',
  'pricing',
  'table',
  'toast',
  'modal',
  'switch',
  'avatar',
  'chart',
  'footer',
  'hero',
  'menu',
  'tabs',
  'badge',
  'slider',
  'stepper',
  'upload',
  'search',
  'calendar',
  'banner',
  'sidebar',
]
const KINDS = ['cp', 'bk', 'mo', 'hero', 'footer']
const SOURCES = ['scb', 'tuff', 'fd', 'tk']
const CATEGORIES = [
  'Inputs & forms/Text fields',
  'Inputs & forms/OTP & code inputs',
  'Auth/Log in',
  'Data display/Tables',
  'Feedback/Toasts',
  'Navigation/Menus',
  'Marketing/Heroes',
  'Marketing/Footers',
]
const TAGS = ['dark', 'light', 'auth', 'dense', 'animated', 'mobile']

/** `n` deterministic items: families of one to eight, each a family and
 *  its variants, spread over kinds, sources, categories and tags. */
export function syntheticItems(n: number, canvasId = 'lib1'): LibraryItem[] {
  let seed = 7
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length)]!
  const items: LibraryItem[] = []
  let family = 0
  while (items.length < n) {
    family++
    const kind = pick(KINDS)
    const source = pick(SOURCES)
    const a = pick(WORDS)
    const b = pick(WORDS)
    const familyId = `${kind}.${source}-${a}-${b}-${family}`
    const category = pick(CATEGORIES)
    const size = Math.min(1 + Math.floor(rand() * 8), n - items.length)
    for (let v = 0; v < size; v++) {
      const variant = v > 0
      const word = pick(WORDS)
      const id = variant ? `${familyId}-${word}-${v}` : familyId
      items.push({
        canvasId,
        itemId: id,
        parentId: variant ? familyId : null,
        frameId: `frame-${family}`,
        pageId: 'p1',
        position: v,
        label: variant ? `${a} ${b} · ${word}` : `${a} ${b}`,
        description: '',
        kind,
        source,
        category,
        tags: [pick(TAGS)],
        mode: 'snapshot',
        locator: variant ? { anchor: id } : { whole: true },
        box: null,
        scripted: false,
        status: 'active',
        findings: [],
        hash: `h${family}-${v}`,
        rev: 1,
        searchText: `${a} ${b} ${word} ${pick(WORDS)}`,
        sourceUrl: null,
        license: null,
        indexedAt: 1,
      })
    }
  }
  return items
}
