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
import { api, ApiError } from './api'
import { useStore } from './store'

/* an html change re-arms the wait: a stream lands in many chunks and only
   the settled document is worth scoring */
const LINT_DEBOUNCE_MS = 1500

type LintedFrame = Pick<Frame, 'id' | 'html' | 'width' | 'height' | 'updatedAt'>

const timers = new Map<string, number>()
/* frameId → the document (`lintDocKey`) a pass is measuring or waiting to
   measure, so a second schedule for it does not stack another render */
const pending = new Map<string, string>()

/* frameId → the document this tab scored or found current. Every schedule
   of that document is then a no-op: the verdict the tab wrote coming back as
   `frame:lint`, the server's echo of a save the tab already scored, another
   render of the same frame. A short key, so the map stays small. */
const scored = new Map<string, string>()

/* frameId → the document whose verdict PUT the server refused with a 409
   (it still held an older document: a resize scored before its save). The
   save's echo then restores the server's older verdict, and that schedule
   scores the document again instead of trusting `scored`. Only a save's
   echo re-arms it, so it cannot loop; a 403 or an offline failure is not
   retried. */
const refused = new Map<string, string>()

/* frameId → the document last hashed and its key: a frame re-renders far
   more often than its document changes, and the hash reads the whole html.
   A local patch keeps `updatedAt` (the save's echo bumps it), so with the
   length and the size it stands in for the html — no copy of it is kept. */
const keys = new Map<string, { updatedAt: number; htmlLength: number; width: number; height: number; key: string }>()

function docKeyOf(frame: LintedFrame): string {
  const cached = keys.get(frame.id)
  if (
    cached &&
    cached.updatedAt === frame.updatedAt &&
    cached.htmlLength === frame.html.length &&
    cached.width === frame.width &&
    cached.height === frame.height
  )
    return cached.key
  const key = lintDocKey(frame)
  keys.set(frame.id, {
    updatedAt: frame.updatedAt,
    htmlLength: frame.html.length,
    width: frame.width,
    height: frame.height,
    key,
  })
  return key
}

function cancel(frameId: string) {
  const timer = timers.get(frameId)
  if (timer !== undefined) window.clearTimeout(timer)
  timers.delete(frameId)
}

export function scheduleFrameLint(frame: Frame) {
  if (!frame.html || frame.demo) return
  const key = docKeyOf(frame)
  if (scored.get(frame.id) === key) {
    /* a refused verdict is scored again once the server holds this
       document: the echo of the save lands carrying the server's older
       verdict, so it no longer names this document */
    if (refused.get(frame.id) !== key || frame.lint?.doc === key) return
    refused.delete(frame.id)
    scored.delete(frame.id)
  }
  const lint = frame.lint
  /* the verdict covers the document it scored: a pass with computed
     styles, under today's rules, of this html at this size — the key
     says it, not a timestamp (a local save patches the html ahead of the
     server's `updatedAt`) */
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
    /* set before the write, so the echo is not scored again; a write the
       server refuses (409: it still holds an older document) is retried
       from `refused` once the save's echo lands */
    scored.set(frameId, key)
    await api.setFrameLint(frameId, lint)
    refused.delete(frameId)
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) refused.set(frameId, key)
    console.error('frame lint failed', error)
  } finally {
    if (owns()) pending.delete(frameId)
  }
}
