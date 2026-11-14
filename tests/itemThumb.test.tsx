// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { cropStyle, ItemThumb } from '../src/components/library/ItemThumb'
import { OTP_RESULT } from './libraryFindFixtures'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLDivElement | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
})

async function render(node: React.ReactNode) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(node))
  return host
}

const base = OTP_RESULT.hits[0]!.item

describe('ItemThumb', () => {
  it('computes the crop of a box from the frame size', () => {
    expect(cropStyle({ x: 500, y: 100, w: 500, h: 250 }, { w: 2000, h: 1000 })).toEqual({
      width: '400%',
      height: '400%',
      left: '-100%',
      top: '-40%',
    })
  })

  it('shows its own thumbnail, and crops the frame preview when it fails', async () => {
    const item = {
      ...base,
      thumb: '/api/libraries/lib1/items/x/thumb.jpg?v=h',
      box: { x: 500, y: 100, w: 500, h: 250 },
      frameSize: { w: 2000, h: 1000 },
    }
    const el = await render(<ItemThumb item={item} />)
    const img = el.querySelector('img')!
    expect(img.getAttribute('src')).toBe(item.thumb)
    await act(async () => img.dispatchEvent(new Event('error')))
    const crop = el.querySelector('[data-crop="frame"] img')!
    expect(crop.getAttribute('src')).toBe(`/i/${item.frameId}.jpg?preview`)
    expect((crop as HTMLImageElement).style.width).toBe('400%')
  })

  it('falls back to the frame preview when it has no box', async () => {
    const el = await render(<ItemThumb item={{ ...base, box: null }} />)
    expect(el.querySelector('img')!.getAttribute('src')).toBe(`/i/${base.frameId}.jpg?preview`)
  })
})
