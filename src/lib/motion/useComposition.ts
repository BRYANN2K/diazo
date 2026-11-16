import { useCallback, useEffect, useState } from 'react'
import { ApiError } from '../api'
import { motionApi } from './api'
import type { Composition, CompositionOp } from './contract'

export type CompositionState =
  { status: 'loading' } | { status: 'error' } | { status: 'ready'; composition: Composition | null }

/**
 * The timeline of one page, read over REST and written with patch ops that
 * carry the revision the editor last saw. A 409 (someone else wrote first)
 * reloads it and reports `conflict`.
 *
 * ADAPTER: the room also broadcasts `composition` messages (and the canvas
 * init carries `compositions`); until this branch's room client knows that
 * message, the timeline refreshes when the window regains focus.
 */
export function useComposition(canvasId: string, pageId: string | null) {
  const [state, setState] = useState<CompositionState>({ status: 'loading' })
  const [key, setKey] = useState(`${canvasId}/${pageId}`)
  if (key !== `${canvasId}/${pageId}`) {
    setKey(`${canvasId}/${pageId}`)
    setState({ status: 'loading' })
  }

  const reload = useCallback(async () => {
    if (!pageId) return
    try {
      const { composition } = await motionApi.get(canvasId, pageId)
      setState({ status: 'ready', composition })
    } catch {
      setState({ status: 'error' })
    }
  }, [canvasId, pageId])

  useEffect(() => {
    if (!pageId) return
    let alive = true
    motionApi
      .get(canvasId, pageId)
      .then(({ composition }) => alive && setState({ status: 'ready', composition }))
      .catch(() => alive && setState({ status: 'error' }))
    const onFocus = () => void reload()
    window.addEventListener('focus', onFocus)
    return () => {
      alive = false
      window.removeEventListener('focus', onFocus)
    }
  }, [canvasId, pageId, reload])

  const create = useCallback(
    async (meta: { duration: number; fps: number; width: number; height: number }) => {
      if (!pageId) return
      const { composition } = await motionApi.create(canvasId, pageId, meta)
      setState({ status: 'ready', composition })
    },
    [canvasId, pageId],
  )

  /** apply ops; resolves to 'ok', 'conflict' (reloaded) or throws */
  const patch = useCallback(
    async (ops: CompositionOp[]): Promise<'ok' | 'conflict'> => {
      if (!pageId || state.status !== 'ready' || !state.composition) return 'ok'
      try {
        const { composition } = await motionApi.patch(canvasId, pageId, ops, state.composition.revision)
        setState({ status: 'ready', composition })
        return 'ok'
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          await reload()
          return 'conflict'
        }
        throw err
      }
    },
    [canvasId, pageId, state, reload],
  )

  return { state, reload, create, patch }
}
