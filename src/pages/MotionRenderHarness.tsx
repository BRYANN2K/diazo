import { useEffect, useRef, useState } from 'react'
import { pageFrames } from '../../shared/pages'
import { api } from '../lib/api'
import { motionApi } from '../lib/motion/api'
import { paintShutter, prepareStage, type FilmStage } from '../lib/motion/compositor'
import type { Composition } from '../lib/motion/contract'

declare global {
  interface Window {
    /** the shell's seek: draw the film at `t` seconds (plus the range start) */
    __doopMotionSeek?: (t: number) => Promise<void>
    /** the shell's capture: the current picture as a PNG data URL */
    __doopMotionCapture?: () => string
    /** resolves once the stage is ready to be seeked */
    __doopMotionReady?: Promise<void>
    /** the scene effects the last seek could not draw — the render reports
     *  them instead of silently shipping a film without its look */
    __doopMotionFxStatus?: { fx: string; reason: string }[]
    /** the agent's eyes: a contact sheet of the film at `times`, with the
     *  luminance/motion stats each cell carries (motion-pro) */
    __doopMotionSheet?: (opts: { times: number[]; columns?: number; maxSide?: number; labels?: boolean }) => Promise<{
      png: string
      width: number
      height: number
      cells: { t: number; x: number; y: number; w: number; h: number; mean: number; stddev: number }[]
      motionEnergy: number[]
    }>
    /** measured text boxes per frame: rects, font sizes, computed colors —
     *  the legibility check's raw material (motion-pro) */
    __doopMotionMeasure?: () => Promise<
      {
        frameId: string
        elementId: string
        x: number
        y: number
        w: number
        h: number
        fontSize: number
        fontWeight: string
        color: string
        background: string
        text: string
      }[]
    >
  }
}

const SHEET_MAX_SIDE = 1280
const SHEET_MAX_CELLS = 24

/* luminance (Rec.709) on a strided pixel sample — the sheet's per-cell
   stats and the frame-diff behind motion energy */
function lumaGrid(canvas: HTMLCanvasElement, w = 64): Float32Array {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const h = Math.max(1, Math.round((w * canvas.height) / Math.max(1, canvas.width)))
  const tmp = document.createElement('canvas')
  tmp.width = w
  tmp.height = h
  const tctx = tmp.getContext('2d', { willReadFrequently: true })!
  tctx.drawImage(canvas, 0, 0, w, h)
  const data = tctx.getImageData(0, 0, w, h).data
  const grid = new Float32Array(w * h)
  for (let i = 0; i < grid.length; i++) {
    const o = i * 4
    grid[i] = (0.2126 * data[o]! + 0.7152 * data[o + 1]! + 0.0722 * data[o + 2]!) / 255
  }
  void ctx
  return grid
}

/**
 * `/c/<id>/motion-render?page=<pageId>&start=<s>`: the render harness the
 * desktop shell loads in a hidden webview (docs/motion-api.md, "Desktop
 * bridge"). It draws the film with the same compositor the browser render
 * uses and answers `__doopMotionSeek(t)` / `__doopMotionCapture()`, so the
 * shell drives the clock and every frame depends on `t` alone.
 *
 * motion-pro adds `__doopMotionSheet` (a labelled contact sheet + stats —
 * how the agent sees its render) and `__doopMotionMeasure` (DOM-measured
 * text boxes for the legibility check).
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
      window.__doopMotionFxStatus = film && ctx ? await paintShutter(ctx, film.comp, film.stage, start + t) : []
    }
    window.__doopMotionCapture = () => canvasRef.current?.toDataURL('image/png') ?? ''
    window.__doopMotionSheet = async ({ times, columns, maxSide, labels }) => {
      await window.__doopMotionReady
      if (!film) throw new Error('no film')
      const { comp, stage } = film
      const ctx = canvasRef.current?.getContext('2d')
      if (!canvasRef.current || !ctx) throw new Error('no render canvas')
      const cells = Math.min(times.length, SHEET_MAX_CELLS)
      const cols = Math.max(1, Math.min(columns ?? Math.ceil(Math.sqrt(cells)), cells))
      const rows = Math.ceil(cells / cols)
      const labelH = labels === false ? 0 : 18
      const cellW = Math.min(comp.width, maxSide ?? 480)
      const cellH = Math.round((cellW * comp.height) / comp.width) + labelH
      const sheet = document.createElement('canvas')
      sheet.width = Math.min(cols * cellW, SHEET_MAX_SIDE)
      const scaleDown = sheet.width / (cols * cellW)
      sheet.width = Math.round(cols * cellW * scaleDown)
      sheet.height = Math.round(rows * cellH * scaleDown)
      const sctx = sheet.getContext('2d')!
      sctx.fillStyle = '#111'
      sctx.fillRect(0, 0, sheet.width, sheet.height)
      const out: Awaited<ReturnType<NonNullable<typeof window.__doopMotionSheet>>> = {
        png: '',
        width: sheet.width,
        height: sheet.height,
        cells: [],
        motionEnergy: [],
      }
      let prev: Float32Array | undefined
      const fxDrops = new Map<string, { fx: string; reason: string }>()
      for (let i = 0; i < cells; i++) {
        const t = times[i]!
        for (const d of await paintShutter(ctx, comp, stage, start + t)) fxDrops.set(`${d.fx}:${d.reason}`, d)
        window.__doopMotionFxStatus = [...fxDrops.values()]
        const col = i % cols
        const row = Math.floor(i / cols)
        const dx = col * cellW * scaleDown
        const dy = row * cellH * scaleDown
        const dh = cellW * scaleDown * (comp.height / comp.width)
        sctx.drawImage(canvasRef.current, dx, dy, cellW * scaleDown, dh)
        const grid = lumaGrid(canvasRef.current)
        let mean = 0
        for (const v of grid) mean += v
        mean /= grid.length
        let variance = 0
        for (const v of grid) variance += (v - mean) * (v - mean)
        out.cells.push({
          t,
          x: Math.round(dx),
          y: Math.round(dy),
          w: Math.round(cellW * scaleDown),
          h: Math.round(dh),
          mean,
          stddev: Math.sqrt(variance / grid.length),
        })
        if (prev) {
          let diff = 0
          for (let p = 0; p < grid.length; p++) diff += Math.abs(grid[p]! - prev[p]!)
          out.motionEnergy.push(diff / grid.length)
        }
        prev = grid
        if (labels !== false) {
          sctx.fillStyle = '#ddd'
          sctx.font = `${Math.max(10, 12 * scaleDown)}px sans-serif`
          sctx.fillText(`t=${t.toFixed(2)}s`, dx + 6 * scaleDown, dy + dh + 13 * scaleDown)
        }
      }
      out.png = sheet.toDataURL('image/png')
      return out
    }
    window.__doopMotionMeasure = async () => {
      await window.__doopMotionReady
      if (!film) throw new Error('no film')
      const boxes: Awaited<ReturnType<NonNullable<typeof window.__doopMotionMeasure>>> = []
      for (const entry of film.stage.frames) {
        const frame = entry.frame
        /* a sandboxed srcdoc: layout runs, scripts never do — the measure is
           deterministic whatever the frame's markup tries to run */
        const iframe = document.createElement('iframe')
        iframe.setAttribute('sandbox', 'allow-same-origin')
        iframe.style.cssText = `position:fixed;left:-${frame.width + 100}px;top:0;width:${frame.width}px;height:${frame.height}px;border:0;visibility:hidden;pointer-events:none`
        document.body.appendChild(iframe)
        try {
          iframe.srcdoc = frame.html
          await new Promise((r) => {
            iframe.onload = r
            setTimeout(r, 1500)
          })
          const doc = iframe.contentDocument
          if (!doc) continue
          await doc.fonts?.ready?.catch(() => {})
          /* the backdrop the text actually sits on: the nearest ancestor
             (or the element itself) with a painted background — an element's
             own transparent background would grade contrast against the
             wrong colour */
          const backdrop = (el: Element): string => {
            for (let node: Element | null = el; node; node = node.parentElement) {
              const bg = doc.defaultView?.getComputedStyle(node).backgroundColor ?? ''
              if (bg && bg !== 'transparent' && !/^rgba?\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(bg)) return bg
            }
            return film!.stage.ground
          }
          for (const el of doc.querySelectorAll('[data-doop-id]')) {
            const text = (el.textContent ?? '').trim()
            if (!text) continue
            const rect = el.getBoundingClientRect()
            const cs = doc.defaultView?.getComputedStyle(el)
            if (!cs || rect.width < 1 || rect.height < 1) continue
            boxes.push({
              frameId: frame.id,
              elementId: el.getAttribute('data-doop-id') ?? '',
              x: rect.x,
              y: rect.y,
              w: rect.width,
              h: rect.height,
              fontSize: Number.parseFloat(cs.fontSize) || 0,
              fontWeight: cs.fontWeight,
              color: cs.color,
              background: backdrop(el),
              text: text.slice(0, 120),
            })
          }
        } finally {
          iframe.remove()
        }
      }
      return boxes
    }
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
      delete window.__doopMotionSheet
      delete window.__doopMotionMeasure
    }
  }, [canvasId])

  return (
    <main className="grid min-h-full place-items-start bg-ground">
      <canvas ref={canvasRef} width={size.width} height={size.height} data-slot="motion-render" />
      {error && <p className="p-4 text-body text-danger">! {error}</p>}
    </main>
  )
}
