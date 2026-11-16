import { useCallback, useEffect, useState } from 'react'
import { ApiError } from '../api'
import { motionApi } from './api'
import type { Composition, CompositionOp } from './contract'
import { useMotionStore } from './store'

export type CompositionState =
  { status: 'loading' } | { status: 'error' } | { status: 'ready'; composition: Composition | null }

/**
 * The timeline of one page. The room carries it (`init.canvas.compositions`,
 * then every `composition` message, src/lib/motion/store.ts), so every open
 * timeline follows the others live; REST answers when the room has not said
 * anything about the page yet. Writes are patch ops carrying the revision
 * the editor last saw; a 409 (someone else wrote first) reloads and reports
 * `conflict`.
 */
export function useComposition(canvasId: string, pageId: string | null) {
  const fromRoom = useMotionStore((s) => (pageId ? s.compositions[pageId] : undefined))
  const setComposition = useMotionStore((s) => s.setComposition)
  const [failed, setFailed] = useState(false)

  const reload = useCallback(async () => {
    if (!pageId) return
    try {
      const { composition } = await motionApi.get(canvasId, pageId)
      setComposition(pageId, composition)
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [canvasId, pageId, setComposition])

  /* the room has not mentioned this page: ask once */
  const known = fromRoom !== undefined
  useEffect(() => {
    if (!pageId || known) return
    let alive = true
    motionApi
      .get(canvasId, pageId)
      .then(({ composition }) => alive && setComposition(pageId, composition))
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [canvasId, pageId, known, setComposition])

  const state: CompositionState =
    fromRoom !== undefined
      ? { status: 'ready', composition: fromRoom }
      : failed
        ? { status: 'error' }
        : { status: 'loading' }

  const create = useCallback(
    async (meta: { duration: number; fps: number; width: number; height: number }) => {
      if (!pageId) return
      const { composition } = await motionApi.create(canvasId, pageId, meta)
      setComposition(pageId, composition)
    },
    [canvasId, pageId, setComposition],
  )

  /** apply ops; resolves to 'ok', 'conflict' (reloaded) or throws */
  const patch = useCallback(
    async (ops: CompositionOp[]): Promise<'ok' | 'conflict'> => {
      if (!pageId || !fromRoom) return 'ok'
      try {
        const { composition } = await motionApi.patch(canvasId, pageId, ops, fromRoom.revision)
        setComposition(pageId, composition)
        return 'ok'
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          await reload()
          return 'conflict'
        }
        throw err
      }
    },
    [canvasId, pageId, fromRoom, reload, setComposition],
  )

  return { state, reload, create, patch }
}
