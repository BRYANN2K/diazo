import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import {
  contactSheet,
  SHEET_CELL,
  SHEET_COLS,
  SHOT_MAX_EDGE,
  shotScaleFor,
  watchPageConsole,
} from '../server/screenshot.ts'
import type { Frame } from '../shared/types.ts'

/* AC-5: a screenshot's long edge is bounded (1568 by default, max_edge when
   asked), region crops it, frame_ids comes back as one contact sheet. */

const frame = (id: string): Frame =>
  ({
    id,
    canvasId: 'c',
    name: id,
    html: '',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    createdAt: 0,
    updatedAt: 0,
    updatedBy: 't',
  }) as Frame

async function png(width: number, height: number, rgb: string): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: rgb } })
    .png()
    .toBuffer()
}

describe('shotScaleFor', () => {
  it('caps the long edge at max_edge, never upscales', () => {
    expect(shotScaleFor(2000, 1000, 1, SHOT_MAX_EDGE)).toBeCloseTo(1568 / 2000)
    expect(shotScaleFor(2000, 1000, 2, SHOT_MAX_EDGE)).toBeCloseTo(1568 / 2000)
    expect(shotScaleFor(800, 600, 1, SHOT_MAX_EDGE)).toBe(1)
    /* scale 2 would make a 1600px edge — the output cap pulls it to 1.96 */
    expect(shotScaleFor(800, 600, 2, SHOT_MAX_EDGE)).toBeCloseTo(1568 / 800)
  })

  it('bounds a region capture by the region size, not the frame', () => {
    expect(shotScaleFor(300, 200, 1, 150)).toBeCloseTo(0.5)
  })
})

describe('contactSheet', () => {
  it('composites every thumbnail into one image, in order on a grid', async () => {
    const shots = await Promise.all(
      [
        await png(900, 600, '#c00'),
        await png(400, 400, '#0c0'),
        await png(1000, 300, '#00c'),
        await png(200, 800, '#cc0'),
      ].map(async (p, i) => ({ frame: frame(`f${i}`), png: p })),
    )
    const sheet = await contactSheet(shots)
    const meta = await sharp(sheet).metadata()
    /* 4 frames -> 3 cols x 2 rows of cells with gaps between and around */
    const gap = 16
    expect(meta.width).toBe(3 * SHEET_CELL.width + 4 * gap)
    expect(meta.height).toBe(2 * SHEET_CELL.height + 3 * gap)
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(SHOT_MAX_EDGE)
    expect(SHEET_COLS).toBe(3)
  })

  it('keeps one frame on a single-cell sheet', async () => {
    const sheet = await contactSheet([{ frame: frame('solo'), png: await png(640, 480, '#123456') }])
    const meta = await sharp(sheet).metadata()
    expect(meta.width).toBe(SHEET_CELL.width + 32)
    expect(meta.height).toBe(SHEET_CELL.height + 32)
  })
})

it('forwards pageerror exceptions into console errors', () => {
  const handlers: Record<string, (...args: unknown[]) => void> = {}
  const fakePage = {
    on: (event: string, fn: (...args: unknown[]) => void) => {
      handlers[event] = fn
      return fakePage
    },
  }
  const seen: [string, string][] = []
  watchPageConsole(fakePage as never, (type, text) => seen.push([type, text]))
  handlers['console']!({ type: () => 'warning', text: () => 'w' })
  /* an uncaught exception in the frame's own script is a pageerror, not a
     console message — it must still land as an error */
  handlers['pageerror']!(new Error('frame script exploded'))
  expect(seen).toEqual([
    ['warning', 'w'],
    ['error', 'frame script exploded'],
  ])
})
