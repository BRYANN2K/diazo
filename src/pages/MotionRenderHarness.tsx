import { useEffect, useRef, useState } from 'react'
import { pageFrames } from '../../shared/pages'
import { api } from '../lib/api'
import { motionApi } from '../lib/motion/api'
import { paintAt, prepareStage, type FilmStage } from '../lib/motion/compositor'
import type { Composition } from '../lib/motion/contract'

declare global {
  interface Window {
    /** the shell's seek: draw the film at `t` seconds (plus the range start) */
    __doopMotionSeek?: (t: number) => Promise<void>
    /** the shell's capture: the current picture as a PNG data URL */
    __doopMotionCapture?: () => string
    /** resolves once the stage is ready to be seeked */
    __doopMotionReady?: Promise<void>
  }
}

/**
 * `/c/<id>/motion-render?page=<pageId>&start=<s>`: the render harness the
 * desktop shell loads in a hidden webview (docs/motion-api.md, "Desktop
 * bridge"). It draws the film with the same compositor the browser render
 * uses and answers `__doopMotionSeek(t)` / `__doopMotionCapture()`, so the
 * shell drives the clock and every frame depends on `t` alone.
 */
export function MotionRenderHarness({ canvasId }: { canvasId: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [size, setSize] = useState({ width: 16, height: 16 })

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const pageId = params.get('page') ?? ''
    const start = Number(params.get('start') ?? 0) || 0
    let film: { comp: Composition; stage: FilmStage } | null = null
    let markReady: () => void = () => {}
    window.__doopMotionReady = new Promise<void>((resolve) => (markReady = resolve))
    window.__doopMotionSeek = async (t: number) => {
      await window.__doopMotionReady
      const ctx = canvasRef.current?.getContext('2d')
      if (film && ctx) await paintAt(ctx, film.comp, film.stage, start + t)
    }
    window.__doopMotionCapture = () => canvasRef.current?.toDataURL('image/png') ?? ''
    void (async () => {
      try {
        const [canvas, { composition }] = await Promise.all([api.getCanvas(canvasId), motionApi.get(canvasId, pageId)])
        if (!composition) throw new Error('this page has no film')
        const ground = getComputedStyle(document.documentElement).getPropertyValue('--ground').trim() || '#eef0f2'
        const stage = await prepareStage(composition, pageFrames(canvas, pageId), { ground })
        film = { comp: composition, stage }
        /* sized at once, not on the next render, so the first seek draws whole */
        if (canvasRef.current) {
          canvasRef.current.width = composition.width
          canvasRef.current.height = composition.height
        }
        setSize({ width: composition.width, height: composition.height })
        markReady()
      } catch (err) {
        setError(String(err))
      }
    })()
    return () => {
      delete window.__doopMotionSeek
      delete window.__doopMotionCapture
      delete window.__doopMotionReady
    }
  }, [canvasId])

  return (
    <main className="grid min-h-full place-items-start bg-ground">
      <canvas ref={canvasRef} width={size.width} height={size.height} data-slot="motion-render" />
      {error && <p className="p-4 text-body text-danger">! {error}</p>}
    </main>
  )
}
