/**
 * Client-side anti-slop lint: after a frame's document settles in its iframe,
 * ask the runtime for a SlopSnapshot (shared/slopCollect.ts), score it with
 * the shared rules and write the result back through the API — the server
 * relays it to the room as `frame:lint`. Agent-made changes get the same
 * result from the server (server/lint.ts); this path covers human edits.
 */
import type { Frame } from '../../shared/types'
import { SLOP_RULES_VERSION, lintSnapshot } from '../../shared/slopRules'
import { lintDocKey } from '../../shared/lintDocument'
import { slopSnapshotOf } from './frameBridge'
import { api } from './api'
import { useStore } from './store'

/* an html change re-arms the wait: a stream lands in many chunks and only
   the settled document is worth scoring */
const LINT_DEBOUNCE_MS = 1500

type LintedFrame = Pick<Frame, 'id' | 'html' | 'width' | 'height'>

const timers = new Map<string, number>()
/* frameId → the document (`lintDocKey`) a pass is measuring or waiting to
   measure, so a second schedule for it does not stack another render */
const pending = new Map<string, string>()

/* frameId → the document this tab scored or found current. Every schedule
   of that document is then a no-op: the verdict the tab wrote coming back as
   `frame:lint`, the server's echo of a save the tab already scored, another
   render of the same frame. A short key, so the map stays small. */
const scored = new Map<string, string>()

/* frameId → the last html hashed and its key: a frame re-renders far more
   often than its document changes */
const keys = new Map<string, { html: string; width: number; height: number; key: string }>()

function docKeyOf(frame: LintedFrame): string {
  const cached = keys.get(frame.id)
  if (cached && cached.html === frame.html && cached.width === frame.width && cached.height === frame.height)
    return cached.key
  const key = lintDocKey(frame)
  keys.set(frame.id, { html: frame.html, width: frame.width, height: frame.height, key })
  return key
}

/** Whether the frame's stored verdict covers the document it shows now: a
 *  pass with computed styles, under today's rules, of this very HTML at this
 *  size. Keyed on what was scored, not on timestamps, since a local save
 *  patches the HTML ahead of the server's `updatedAt`. A verdict from before
 *  the key existed is scored once more. */
export function lintIsCurrent(frame: Pick<Frame, 'lint' | 'html' | 'width' | 'height'>): boolean {
  const lint = frame.lint
  return !!lint && lint.engine === 'dom' && lint.version === SLOP_RULES_VERSION && lint.doc === lintDocKey(frame)
}

function cancel(frameId: string) {
  const timer = timers.get(frameId)
  if (timer !== undefined) window.clearTimeout(timer)
  timers.delete(frameId)
}

export function scheduleFrameLint(frame: Frame) {
  if (!frame.html || frame.demo) return
  const key = docKeyOf(frame)
  if (scored.get(frame.id) === key) return
  const lint = frame.lint
  if (lint && lint.engine === 'dom' && lint.version === SLOP_RULES_VERSION && lint.doc === key) {
    /* someone (another tab, the server) scored this document already */
    cancel(frame.id)
    pending.delete(frame.id)
    scored.set(frame.id, key)
    return
  }
  if (pending.get(frame.id) === key) return
  cancel(frame.id)
  pending.set(frame.id, key)
  timers.set(
    frame.id,
    window.setTimeout(() => {
      timers.delete(frame.id)
      void runFrameLint(frame.id, key)
    }, LINT_DEBOUNCE_MS),
  )
}

function currentFrame(frameId: string) {
  return useStore.getState().canvas?.frames.find((f) => f.id === frameId)
}

async function runFrameLint(frameId: string, key: string) {
  const owns = () => pending.get(frameId) === key
  try {
    const current = currentFrame(frameId)
    /* the document moved on while we waited: a newer schedule owns it now */
    if (!owns() || !current || docKeyOf(current) !== key) return
    const snap = await slopSnapshotOf(frameId)
    /* not mounted (off-screen) or the collector failed: nothing to write */
    if (!snap) return
    const after = currentFrame(frameId)
    if (!owns() || !after || docKeyOf(after) !== key) return
    const lint = { ...lintSnapshot(snap), doc: key }
    /* show it at once; the server's frame:lint confirms it to the room */
    useStore.getState().patchFrameLocal(frameId, { lint })
    /* set before the write, so the echo is not scored again; a refused
       write (offline, a viewer) is not retried for the same document */
    scored.set(frameId, key)
    await api.setFrameLint(frameId, lint)
  } catch (error) {
    console.error('frame lint failed', error)
  } finally {
    if (owns()) pending.delete(frameId)
  }
}
