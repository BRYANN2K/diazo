/**
 * Render a library item's thumbnail from a frame's HTML file, the way the
 * server does, to check what a tile will show. Writes `<name>.after.jpg`
 * (today's thumbnail) and `<name>.before.jpg` (the old clip of the item's
 * box plus a margin) next to each other.
 *
 *   bunx tsx scripts/library-thumb.ts frame.html --id mo.bencho-particles \
 *     --width 760 --height 560 [--box x,y,w,h] [--out dir] [--wait background]
 *
 * Without --box the item is the whole frame (a family's box). Needs a local
 * Chrome (CHROME_PATH when it is not found).
 */
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { launchBrowser } from '../server/screenshot.ts'
import { captureItems, TIMING } from '../server/libraryThumbRender.ts'
import { thumbPage, thumbViewport } from '../server/libraryThumbs.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    id: { type: 'string' },
    width: { type: 'string', default: '760' },
    height: { type: 'string', default: '560' },
    box: { type: 'string' },
    out: { type: 'string', default: '.' },
    wait: { type: 'string', default: 'background' },
  },
})

const file = positionals[0]
if (!file || !values.id) {
  console.error('usage: library-thumb.ts frame.html --id <item id> [--width] [--height] [--box x,y,w,h] [--out dir]')
  process.exit(1)
}
const frame = { width: Number(values.width), height: Number(values.height) }
const [bx = 0, by = 0, bw = frame.width, bh = frame.height] = (values.box ?? '').split(',').filter(Boolean).map(Number)
const box = { x: bx, y: by, w: bw, h: bh }
const name = path.join(values.out, path.basename(file, '.html'))
const timing = values.wait === 'interactive' ? TIMING.interactive : TIMING.background

const browser = await launchBrowser()
try {
  const page = await browser.newPage()
  await page.setViewport(thumbViewport(frame))
  await page.setContent(fs.readFileSync(file, 'utf8'), { waitUntil: 'load', timeout: 15_000 }).catch(() => {})

  /* before: the item's box plus 12 px, as the first thumbnails were taken */
  const clip = {
    x: Math.max(0, box.x - 12),
    y: Math.max(0, box.y - 12),
    width: Math.min(frame.width, box.x + box.w + 12) - Math.max(0, box.x - 12),
    height: box.h + 24,
  }
  const scale = Math.min(1, 640 / Math.max(clip.width, clip.height))
  await new Promise((resolve) => setTimeout(resolve, 120))
  fs.writeFileSync(`${name}.before.jpg`, await page.screenshot({ type: 'jpeg', quality: 82, clip: { ...clip, scale } }))

  const started = Date.now()
  const [after] = await captureItems(thumbPage(page), [{ itemId: values.id, box }], timing)
  if (!after || after instanceof Error) throw after ?? new Error('no picture')
  fs.writeFileSync(`${name}.after.jpg`, after)
  console.log(`${name}.before.jpg  ${name}.after.jpg  (${Date.now() - started} ms)`)
} finally {
  await browser.close()
}
