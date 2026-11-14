import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import {
  chooseThumbClip,
  FONTS_READY_SOURCE,
  SETTLE_ANIMATIONS_SOURCE,
  type ThumbNode,
  type ThumbRect,
} from '../server/libraryThumbClip'
import {
  captureItems,
  cornerColour,
  frameContent,
  THUMB_H,
  THUMB_W,
  type ThumbClipRegion,
  type ThumbPage,
} from '../server/libraryThumbRender'
import { thumbFailure, ThumbsBusyError, NoThumbError, requestThumb, type ThumbDeps } from '../server/libraryThumbs'
import { RendererBusyError } from '../server/renderBrowser'
import { syntheticItems } from './libraryFixtures'

/**
 * Where a thumbnail looks (the demo, not the sheet's label and caption),
 * how it is framed, the settle steps before the picture, and what the
 * gallery route answers when it cannot have one.
 */

const n = (x: number, y: number, w: number, h: number, opts: Partial<ThumbNode> = {}): ThumbNode => ({
  r: { x, y, w, h },
  t: false,
  id: false,
  c: [],
  ...opts,
})

/* a card cut from a wider sheet, as the live mo.bencho-* frames are: the
   label strip, then the card (demo box over a caption naming the item) */
const benchoCard = n(0, 0, 2040, 560, {
  id: true,
  c: [
    n(18, 0, 2004, 34, { t: true, id: true, c: [n(32, 9, 145, 14, { t: true, id: true })] }),
    n(18, 34, 2004, 236, {
      id: true,
      c: [
        n(36, 52, 1968, 200, {
          id: true,
          c: [
            n(37, 53, 1966, 148, { c: [n(917, 108, 206, 38, { c: [n(929, 119, 151, 16, { t: true })] })] }),
            n(37, 201, 1966, 50, { t: true, id: true, c: [n(47, 208, 1946, 14, { t: true, id: true })] }),
          ],
        }),
      ],
    }),
  ],
})

describe('choosing what a thumbnail shows', () => {
  it('walks past the label strip and the caption to the demo box', () => {
    expect(chooseThumbClip(benchoCard)).toEqual({ x: 37, y: 53, w: 1966, h: 148 })
  })

  it('keeps a painted demo box rather than zooming onto the small thing inside it', () => {
    /* card-exploded: libbar naming the item, a padded wrapper, the dark .v
       with a short text button inside */
    const card = n(0, 0, 760, 560, {
      c: [
        n(0, 0, 760, 40, { t: true, id: true }),
        n(0, 40, 760, 336, {
          c: [n(18, 58, 724, 300, { c: [n(18, 58, 490, 260, { c: [n(30, 70, 200, 40, { t: true })] })] })],
        }),
      ],
    })
    expect(chooseThumbClip(card)).toEqual({ x: 18, y: 58, w: 490, h: 260 })
  })

  it('sets a sheet header aside and shows its grid of variants', () => {
    const sheet = n(0, 0, 2040, 440, {
      c: [n(0, 0, 2040, 72, { t: true }), n(0, 72, 2040, 360, { c: [n(0, 72, 490, 340), n(502, 72, 490, 340)] })],
    })
    expect(chooseThumbClip(sheet)).toEqual({ x: 0, y: 72, w: 2040, h: 360 })
  })

  it('shows text-only content when there is nothing else (a type specimen)', () => {
    const specimen = n(0, 0, 800, 400, {
      c: [n(0, 0, 800, 30, { t: true, id: true }), n(0, 40, 800, 80, { t: true }), n(0, 130, 800, 60, { t: true })],
    })
    expect(chooseThumbClip(specimen)).toEqual({ x: 0, y: 40, w: 800, h: 150 })
  })
})

describe('framing at the tile aspect', () => {
  const demo: ThumbRect = { x: 0, y: 0, w: 2000, h: 150 }

  it('gives trimmed content some room, centred at 4:3, inside the demo where it can', () => {
    const { want, take } = frameContent({ x: 900, y: 50, w: 200, h: 40 }, demo)
    expect(want.w / want.h).toBeCloseTo(4 / 3)
    expect(want.x + want.w / 2).toBeCloseTo(1000)
    expect(want.w).toBeGreaterThan(200)
    expect(take.y).toBeGreaterThanOrEqual(0)
    expect(take.y + take.h).toBeLessThanOrEqual(150)
  })

  it('shows full-bleed content whole, letterboxed rather than cropped', () => {
    const stage = { x: 0, y: 0, w: 480, h: 300 }
    const { want, take } = frameContent(stage, stage)
    expect(want.w).toBe(480)
    expect(want.h).toBe(360)
    expect(take).toEqual(stage)
  })

  it('reads the background off the corners most of them share', () => {
    const white = { r: 255, g: 255, b: 255 }
    const beige = { r: 243, g: 241, b: 236 }
    expect(cornerColour([beige, white, white, white])).toEqual(white)
    expect(cornerColour([{ r: 9, g: 9, b: 11 }])).toEqual({ r: 9, g: 9, b: 11 })
  })
})

/** A page whose document is white with a black block in the demo. */
function fakePage(probe: ThumbNode, docWidth: number) {
  const calls: string[] = []
  let view = { width: 760, height: 560 }
  const page: ThumbPage = {
    evaluate: async (expression) => {
      if (expression === FONTS_READY_SOURCE) calls.push('fonts')
      else if (expression === SETTLE_ANIMATIONS_SOURCE) calls.push('animations')
      else if (expression.includes('probeThumb')) {
        calls.push('probe')
        if (expression.includes('"itemId":"broken"')) return { root: null, width: 0, height: 0 }
        return { root: probe, width: docWidth, height: 560 }
      }
      return true
    },
    setViewport: async (v) => {
      calls.push(`viewport ${v.width}x${v.height}`)
      view = { width: v.width, height: v.height }
    },
    viewport: () => view,
    movePointer: async (x, y) => {
      calls.push(`pointer ${Math.round(x)},${Math.round(y)}`)
    },
    screenshot: async (clip: ThumbClipRegion) => {
      calls.push('shot')
      const w = Math.max(1, Math.round(clip.width * clip.scale))
      const h = Math.max(1, Math.round(clip.height * clip.scale))
      const block = await sharp({
        create: {
          width: Math.max(1, Math.round(w / 5)),
          height: Math.max(1, Math.round(h / 3)),
          channels: 3,
          background: '#000',
        },
      })
        .png()
        .toBuffer()
      return sharp({ create: { width: w, height: h, channels: 3, background: '#fff' } })
        .composite([{ input: block, gravity: 'centre' }])
        .png()
        .toBuffer()
    },
  }
  return { page, calls }
}

describe('taking the picture', () => {
  it('settles fonts and animations and brings the pointer to the demo before each picture', async () => {
    const { page, calls } = fakePage(benchoCard, 2040)
    const [jpeg] = await captureItems(page, [{ itemId: 'mo.bencho-copy-field', box: null }], { settleMs: 0, itemMs: 0 })
    expect(jpeg).toBeInstanceOf(Buffer)
    expect(calls[0]).toBe('fonts')
    /* the demo lies past the 760px frame: the viewport reaches it, then it is found again */
    expect(calls).toContain('viewport 2003x560')
    expect(calls.filter((c) => c === 'probe')).toHaveLength(2)
    const settled = calls.indexOf('animations')
    expect(calls.slice(0, settled)).toContain('pointer 1020,127')
    expect(calls.indexOf('shot')).toBeGreaterThan(settled)
    const meta = await sharp(jpeg as Buffer).metadata()
    expect(meta.format).toBe('jpeg')
    expect(meta.width! / meta.height!).toBeCloseTo(THUMB_W / THUMB_H, 1)
  })

  it('fails one item alone', async () => {
    const { page } = fakePage(benchoCard, 760)
    const out = await captureItems(
      page,
      [
        { itemId: 'broken', box: null },
        { itemId: 'mo.bencho-copy-field', box: null },
      ],
      { settleMs: 0, itemMs: 0 },
    )
    expect(out[0]).toBeInstanceOf(Error)
    expect(out[1]).toBeInstanceOf(Buffer)
  })
})

describe('the gallery route', () => {
  it('answers 503 with a short Retry-After when busy, 404 or 500 when it is final', () => {
    expect(thumbFailure(new ThumbsBusyError('gallery share full'))).toMatchObject({ status: 503, retryAfterS: 2 })
    expect(thumbFailure(new RendererBusyError('queue full'))).toMatchObject({ status: 503, retryAfterS: 10 })
    expect(thumbFailure(new NoThumbError('frame gone'))).toMatchObject({ status: 404 })
    expect(thumbFailure(new Error('boom'))).toEqual({ status: 500, message: 'thumbnail failed' })
  })

  it('renders a few gallery thumbnails at once, and refuses the next one as busy', async () => {
    const [a, b] = syntheticItems(2)
    let finish: () => void = () => {}
    const gate = new Promise<void>((resolve) => (finish = resolve))
    const deps: ThumbDeps = {
      render: async (_frame, items) => {
        await gate
        return items.map(() => Buffer.from('jpeg'))
      },
      get: async () => null,
      has: async () => false,
      put: async () => {},
      frame: async () => ({ id: 'f', width: 100, height: 100, html: '' }) as never,
    }
    const first = requestThumb(a!, deps, 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(requestThumb(b!, deps, 1)).rejects.toBeInstanceOf(ThumbsBusyError)
    /* the same key is awaited, not refused */
    const again = requestThumb(a!, deps, 1)
    finish()
    expect((await first).toString()).toBe('jpeg')
    expect((await again).toString()).toBe('jpeg')
  })
})
