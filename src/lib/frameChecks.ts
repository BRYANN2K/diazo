/**
 * Client trigger for the frame checks (shared/frameChecks.ts). The checks lay
 * the frame out at three widths and press Tab through it, which the live
 * iframe on the canvas cannot do without disturbing the person using it, so
 * they run in the server's renderer: once a frame's document settles, ask the
 * server to check it. The server skips unchanged html and shares a pass in
 * flight, then relays the result to the room as `frame:checks`.
 */
import type { Frame } from '../../shared/types'
import { FRAME_CHECKS_VERSION, htmlFingerprint } from '../../shared/frameChecks'
import { api, ApiError } from './api'
import { useStore } from './store'

/* longer than the lint's wait: a pass costs three layouts and a keyboard
   walk in the shared renderer, so only a document that stays put earns one */
const CHECKS_DEBOUNCE_MS = 4000

const timers = new Map<string, number>()
/* the server said it has no renderer: stop asking until the page reloads */
let rendererMissing = false

/** Whether the frame's stored checks describe its current html. */
export function checksAreCurrent(frame: Frame): boolean {
  const checks = frame.checks
  return !!checks && checks.version === FRAME_CHECKS_VERSION && checks.htmlHash === htmlFingerprint(frame.html)
}

export function scheduleFrameChecks(frame: Frame) {
  if (rendererMissing || !frame.html || frame.demo) return
  const html = frame.html
  const timer = timers.get(frame.id)
  if (timer !== undefined) window.clearTimeout(timer)
  timers.set(
    frame.id,
    window.setTimeout(() => {
      timers.delete(frame.id)
      void runFrameChecks(frame.id, html, false)
    }, CHECKS_DEBOUNCE_MS),
  )
}

/** Run the checks now (the Inspector's button), even on unchanged html. */
export function runFrameChecksNow(frameId: string): Promise<boolean> {
  const frame = useStore.getState().canvas?.frames.find((f) => f.id === frameId)
  if (!frame) return Promise.resolve(false)
  return runFrameChecks(frameId, frame.html, true)
}

async function runFrameChecks(frameId: string, html: string, force: boolean): Promise<boolean> {
  const current = useStore.getState().canvas?.frames.find((f) => f.id === frameId)
  /* the document moved on while we waited — a newer schedule owns it now */
  if (!current || current.html !== html) return false
  if (!force && checksAreCurrent(current)) return true
  try {
    const { checks } = await api.runFrameChecks(frameId, force)
    const after = useStore.getState().canvas?.frames.find((f) => f.id === frameId)
    if (after && checks.htmlHash === htmlFingerprint(after.html))
      useStore.getState().patchFrameLocal(frameId, { checks })
    return true
  } catch (error) {
    if (error instanceof ApiError && error.status === 503) rendererMissing = true
    else console.error('frame checks failed', error)
    return false
  }
}
