// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { FrameImage } from '../src/components/FrameImage'
import { FramePreviewCache } from '../src/lib/framePreviews'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => vi.useRealTimers())

it('drops a live cover after three seconds even when its runtime never replies', async () => {
  vi.useFakeTimers()
  const cache = new FramePreviewCache()
  vi.spyOn(cache, 'snapshot').mockReturnValue({
    status: 'ready',
    entry: { version: 1, width: 128, ext: 'jpg', src: 'blob:cover', bytes: 1, stale: false },
  })
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <FrameImage frame={{ id: 'f', width: 1280, updatedAt: 1 }} ext="jpg" load={false} covering cache={cache} />,
      ),
    )
    expect(host.querySelector('img')?.getAttribute('decoding')).toBe('sync')
    expect(host.querySelector('[data-frame-image]')).not.toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2999)
    })
    expect(host.querySelector('[data-frame-image]')).not.toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(host.querySelector('[data-frame-image]')).toBeNull()
  } finally {
    await act(async () => root.unmount())
  }
})
