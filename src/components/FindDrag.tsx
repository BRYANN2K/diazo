import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Frame } from '../../shared/types'
import { frameDesignPoint, frameWorldPoint } from '../../shared/frameRotation'
import { clientToWorld, frameAtPoint } from '../lib/commentMove'
import { canInsertInto, type InsertTarget } from '../lib/findInsert'
import { insertDropTarget, type LayoutDrop } from '../lib/frameBridge'
import { useStore } from '../lib/store'

/** How far the pointer travels before a press on a row becomes a drag. */
const DRAG_THRESHOLD_PX = 4

interface Hover {
  frame: Frame
  /** the slot between elements, when the frame's document answered */
  drop: LayoutDrop | null
}

/**
 * Dragging a library row out of ⌘F onto a frame: the frame under the
 * pointer is outlined and the slot between its elements is drawn as a line,
 * the same slots a moved layer is offered; letting go inserts there. The
 * pointer is captured by the row, so the moves keep arriving over the frames'
 * iframes.
 */
export function useFindDrag() {
  const [ghost, setGhost] = useState<{ label: string; x: number; y: number } | null>(null)
  const [hover, setHover] = useState<Hover | null>(null)
  /* a press that turned into a drag must not also click the row */
  const dragged = useRef(false)
  const stop = useRef<(() => void) | null>(null)
  useEffect(() => () => stop.current?.(), [])

  function start(
    e: ReactPointerEvent<HTMLElement>,
    label: string,
    sourceFrameId: string,
    onDrop: (target: InsertTarget) => void,
  ) {
    if (e.button !== 0) return
    const el = e.currentTarget
    const pointerId = e.pointerId
    const startX = e.clientX
    const startY = e.clientY
    let dragging = false
    let current: Hover | null = null
    let asking = false
    let next: { x: number; y: number } | null = null
    dragged.current = false

    const ask = (clientX: number, clientY: number) => {
      const s = useStore.getState()
      if (!s.canvas) return
      const world = clientToWorld(clientX, clientY)
      const frame = frameAtPoint(s.canvas, s.activePageId ?? null, world)
      if (!canInsertInto(s, frame, sourceFrameId)) {
        current = null
        setHover(null)
        return
      }
      /* a turned frame takes the block at its end: its slots would be drawn unturned */
      if (frame.rotation) {
        current = { frame, drop: null }
        setHover(current)
        return
      }
      if (asking) {
        next = { x: clientX, y: clientY }
        return
      }
      asking = true
      const point = frameDesignPoint(world, frame)
      void insertDropTarget(frame.id, point.x, point.y).then((result) => {
        asking = false
        if (!dragging) return
        current = { frame, drop: result?.drop ?? null }
        setHover(current)
        if (next) {
          const { x, y } = next
          next = null
          ask(x, y)
        }
      })
    }

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD_PX) return
        dragging = true
        dragged.current = true
        try {
          el.setPointerCapture(pointerId)
        } catch {
          /* the element went away */
        }
      }
      setGhost({ label, x: ev.clientX, y: ev.clientY })
      ask(ev.clientX, ev.clientY)
    }
    const end = (drop: boolean) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey, true)
      stop.current = null
      const landed = dragging && drop ? current : null
      dragging = false
      setGhost(null)
      setHover(null)
      if (landed) onDrop({ frame: landed.frame, at: landed.drop?.target ?? null })
    }
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) end(true)
    }
    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) end(false)
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || !dragging) return
      ev.preventDefault()
      ev.stopPropagation()
      end(false)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey, true)
    stop.current = () => end(false)
  }

  /** Call from the row's click: true when the click ends a drag and must be ignored. */
  function swallowClick(): boolean {
    const was = dragged.current
    dragged.current = false
    return was
  }

  const world = hover ? document.querySelector('.stage .world') : null
  const origin = hover ? frameWorldPoint({ x: 0, y: 0 }, hover.frame) : null
  const overlay: ReactNode = (
    <>
      {hover &&
        world &&
        origin &&
        createPortal(
          <div className="pointer-events-none absolute inset-0 z-40" style={{ left: origin.x, top: origin.y }}>
            <div
              data-find-drop-frame={hover.frame.id}
              className="absolute bg-brand/5 [box-shadow:0_0_0_calc(2px/var(--zoom,1))_var(--brand)]"
              style={{ left: 0, top: 0, width: hover.frame.width, height: hover.frame.height }}
            />
            {hover.drop && (
              <div
                data-find-drop-line
                className="absolute bg-brand"
                style={{
                  left: hover.drop.line.x,
                  top: hover.drop.line.y,
                  width: hover.drop.line.width || 'calc(2px / var(--zoom, 1))',
                  height: hover.drop.line.height || 'calc(2px / var(--zoom, 1))',
                }}
              />
            )}
          </div>,
          world,
        )}
      {ghost &&
        createPortal(
          <div
            className="pointer-events-none fixed z-50 rounded-tag bg-surface px-1.5 py-0.5 font-mono text-caption text-ink shadow-pop"
            style={{ left: ghost.x + 12, top: ghost.y + 12 }}
          >
            {ghost.label}
          </div>,
          document.body,
        )}
    </>
  )

  return { start, swallowClick, overlay, dragging: !!ghost }
}
