/**
 * Server-side anti-slop lint. The rendered path loads the frame in the shared
 * headless browser (same pipeline as screenshots), collects a SlopSnapshot
 * there and scores it; without a browser the static rules still run on the
 * HTML alone. Results persist on the frame (store.setFrameLint) and reach
 * the room as a `frame:lint` message.
 */
import type { Actor, Frame } from '../shared/types.ts'
import { lintSnapshot, lintStaticHtml, type FrameLint, type SlopSnapshot } from '../shared/slopRules.ts'
import { SLOP_COLLECTOR_SOURCE } from '../shared/slopCollect.ts'
import { lintDocKey } from '../shared/lintDocument.ts'
import * as actions from './actions.ts'
import { loadFramePage, rendererAvailable } from './screenshot.ts'
import { isScriptWrittenRevision } from './thumbs.ts'
import { store } from './store.ts'

/* the collector is evaluated as an expression: function declaration + call */
const COLLECT_EXPR = `${SLOP_COLLECTOR_SOURCE}\n;collectSlopSnapshot()`

async function lintFrameDom(frame: Frame, opts: { offline?: boolean } = {}): Promise<FrameLint> {
  const loaded = await loadFramePage(frame, { offline: opts.offline })
  try {
    /* tsx's __name helper shim, as inspectOn needs it too */
    await loaded.page.evaluate('globalThis.__name = (target) => target')
    const snap = await loaded.page.evaluate(COLLECT_EXPR)
    return lintSnapshot(snap as SlopSnapshot)
  } finally {
    await loaded.close()
  }
}

/** Score one frame. Browser lint when a renderer exists, static rules as the
 *  fallback — never throws for a bad document. The verdict names the
 *  document it scored (`doc`). `offline` loads the page without network —
 *  script-run checks get the server's own /a/ assets and nothing else. */
export async function lintFrame(frame: Frame, opts: { offline?: boolean } = {}): Promise<FrameLint> {
  const doc = lintDocKey(frame)
  if (rendererAvailable()) {
    try {
      return { ...(await lintFrameDom(frame, opts)), doc }
    } catch (error) {
      console.warn(`[lint] rendered lint failed for frame ${frame.id}, falling back to static rules`, error)
    }
  }
  return { ...lintStaticHtml(frame.html), doc }
}

/** Lint a frame, persist the result on it and broadcast `frame:lint`. A
 *  frame written while it rendered keeps its verdict: this one scored the
 *  previous document, and the next pass scores the new one. */
export async function lintAndStore(frameId: string, actor: Actor): Promise<FrameLint | undefined> {
  const frame = store.getFrame(frameId)
  if (!frame) return undefined
  /* a revision a script run wrote never reaches the network from an
     automatic pass — the same boundary the run's own checks render under */
  const lint = await lintFrame(frame, { offline: isScriptWrittenRevision(frame) })
  const now = store.getFrame(frameId)
  if (now && lintDocKey(now) === lint.doc) actions.setFrameLint(frameId, lint, actor)
  return lint
}
