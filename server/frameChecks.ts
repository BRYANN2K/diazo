/**
 * Server-side frame checks (shared/frameChecks.ts). The frame loads once in
 * the shared headless browser — the screenshot and lint pipeline — then:
 *
 *   1. for each width of FRAME_CHECK_WIDTHS, the viewport is resized and the
 *      viewport collector measures overflow, clipped text, tap targets and
 *      text contrast;
 *   2. at FOCUS_AUDIT_WIDTH, real Tab key presses walk the page and each stop
 *      is compared with how the element painted unfocused.
 *
 * The checks need a rendered page; without a renderer they do not run (the
 * caller reports that rather than a guess). Results persist on the frame
 * (store.setFrameChecks) and reach the room as a `frame:checks` message.
 */
import type { Page } from 'puppeteer-core'
import type { Actor, Frame } from '../shared/types.ts'
import {
  FOCUS_AUDIT_WIDTH,
  FRAME_CHECKS_VERSION,
  FRAME_CHECK_WIDTHS,
  htmlFingerprint,
  scoreFrameChecks,
  viewportHeightFor,
  type FocusAudit,
  type FocusStep,
  type FocusableInfo,
  type FrameChecks,
  type ViewportSnapshot,
} from '../shared/frameChecks.ts'
import { FOCUS_SETUP_EXPR, FOCUS_STEP_EXPR, VIEWPORT_CHECKS_EXPR } from '../shared/frameChecksCollect.ts'
import type { RenderPriority } from './renderBrowser.ts'
import * as actions from './actions.ts'
import { loadFramePage, rendererAvailable } from './screenshot.ts'
import { isScriptWrittenRevision } from './thumbs.ts'
import { store } from './store.ts'

/** The part of a puppeteer page the checks drive — small enough to fake. */
export type CheckPage = Pick<Page, 'setViewport' | 'evaluate'> & {
  keyboard: Pick<Page['keyboard'], 'press'>
}

/** Tab presses beyond the focusable count, for elements the setup could not
 *  see (iframes, shadow roots); the walk stops long before on a normal page. */
const EXTRA_TAB_STOPS = 5
const MAX_TAB_STOPS = 150

/* one animation frame plus a beat, so resize-driven script layout settles */
const SETTLE_EXPR = 'new Promise(function (r) { requestAnimationFrame(function () { setTimeout(r, 30) }) })'

async function measureWidth(page: CheckPage, width: number): Promise<ViewportSnapshot> {
  await page.setViewport({ width, height: viewportHeightFor(width), deviceScaleFactor: 1 })
  await page.evaluate(SETTLE_EXPR)
  const snap = (await page.evaluate(VIEWPORT_CHECKS_EXPR)) as ViewportSnapshot
  /* report the width asked for, whatever innerWidth said */
  return { ...snap, width }
}

/** Walk the page with the Tab key and record every stop. */
export async function walkFocus(page: CheckPage): Promise<FocusAudit> {
  await page.setViewport({
    width: FOCUS_AUDIT_WIDTH,
    height: viewportHeightFor(FOCUS_AUDIT_WIDTH),
    deviceScaleFactor: 1,
  })
  await page.evaluate(SETTLE_EXPR)
  const focusables = ((await page.evaluate(FOCUS_SETUP_EXPR)) as FocusableInfo[] | null) ?? []
  const steps: FocusStep[] = []
  let wrapped = false
  const cap = Math.min(MAX_TAB_STOPS, focusables.length + EXTRA_TAB_STOPS)
  for (let i = 0; i < cap; i++) {
    await page.keyboard.press('Tab')
    const stepResult = (await page.evaluate(FOCUS_STEP_EXPR)) as FocusStep | null
    if (!stepResult) {
      wrapped = true
      break
    }
    steps.push(stepResult)
  }
  return { focusables, steps, wrapped: wrapped || focusables.length === 0 }
}

/** Every measurement, on a page that already holds the frame's document. */
export async function runChecksOnPage(page: CheckPage, html: string, checkedAt = Date.now()): Promise<FrameChecks> {
  /* the tsx/esbuild __name shim the lint and inspect paths install too */
  await page.evaluate('globalThis.__name = (target) => target')
  const viewports: ViewportSnapshot[] = []
  for (const width of FRAME_CHECK_WIDTHS) viewports.push(await measureWidth(page, width))
  let focus: FocusAudit | null = null
  try {
    focus = await walkFocus(page)
  } catch (error) {
    console.warn('[frame-checks] keyboard walk failed', error)
  }
  return scoreFrameChecks({ viewports, focus, htmlHash: htmlFingerprint(html), checkedAt })
}

/** Check one frame in the renderer. Null when no renderer is configured.
 *  `offline` loads the page without network (script-run checks): only the
 *  server's own `/a/` assets still arrive. */
export async function checkFrame(
  frame: Frame,
  priority: RenderPriority = 'interactive',
  opts: { offline?: boolean } = {},
): Promise<FrameChecks | null> {
  if (!rendererAvailable()) return null
  const loaded = await loadFramePage(frame, { priority, offline: opts.offline })
  try {
    return await runChecksOnPage(loaded.page, frame.html)
  } finally {
    await loaded.close()
  }
}

/* frameId → the pass in flight, so a burst of requests for one frame
   shares a render instead of queueing three page loads behind each other */
const inflight = new Map<string, { hash: string; run: Promise<FrameChecks | null> }>()

export type CheckOutcome =
  | { ok: true; checks: FrameChecks; reused: boolean }
  | { ok: false; reason: 'not_found' | 'no_renderer' | 'failed'; error?: string }

/** Check a frame, persist the result on it and broadcast `frame:checks`.
 *  Unchanged html with a current-version result is answered from the frame
 *  unless `force` is set. */
export async function checkAndStore(
  frameId: string,
  actor: Actor,
  opts: { force?: boolean; priority?: RenderPriority } = {},
): Promise<CheckOutcome> {
  const frame = store.getFrame(frameId)
  if (!frame) return { ok: false, reason: 'not_found' }
  const hash = htmlFingerprint(frame.html)
  const prior = frame.checks
  if (!opts.force && prior && prior.htmlHash === hash && prior.version === FRAME_CHECKS_VERSION) {
    return { ok: true, checks: prior, reused: true }
  }
  if (!rendererAvailable()) return { ok: false, reason: 'no_renderer' }
  let pass = inflight.get(frameId)
  if (!pass || pass.hash !== hash) {
    /* a revision a script run wrote never reaches the network from an
       automatic pass — the same boundary the run's own checks render under */
    const run = checkFrame(frame, opts.priority, { offline: isScriptWrittenRevision(frame) })
    pass = { hash, run }
    inflight.set(frameId, pass)
    const settle = () => {
      if (inflight.get(frameId)?.run === run) inflight.delete(frameId)
    }
    run.then(settle, settle)
  }
  try {
    const checks = await pass.run
    if (!checks) return { ok: false, reason: 'no_renderer' }
    /* the document moved on while the page rendered: the result describes
       an html the frame no longer has, so it is returned but not stored */
    const now = store.getFrame(frameId)
    if (now && htmlFingerprint(now.html) === checks.htmlHash) actions.setFrameChecks(frameId, checks, actor)
    return { ok: true, checks, reused: false }
  } catch (error) {
    console.warn(`[frame-checks] frame ${frameId} could not be checked`, error)
    return { ok: false, reason: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
}

const OUTCOME_ERRORS: Record<Exclude<CheckOutcome, { ok: true }>['reason'], string> = {
  not_found: 'frame not found',
  no_renderer: 'frame checks need the server renderer (Chromium or REMOTE_BROWSER_URL), and this server has none',
  failed: 'the renderer could not check this frame',
}

/** The JSON an agent gets back from check_frame (MCP and resident alike). */
export function checkOutcomeForAgent(outcome: CheckOutcome): Record<string, unknown> {
  if (!outcome.ok) {
    return { ok: false, error: OUTCOME_ERRORS[outcome.reason], ...(outcome.error ? { detail: outcome.error } : {}) }
  }
  const c = outcome.checks
  return {
    ok: true,
    reused: outcome.reused,
    checks: {
      score: c.score,
      errors: c.errors,
      warnings: c.warnings,
      checkedAt: c.checkedAt,
      viewports: c.viewports,
      focus: c.focus,
      issues: c.issues.map((i) => ({
        rule: i.ruleId,
        severity: i.severity,
        message: i.message,
        widths: i.widths,
        ...(i.elementId ? { element: i.elementId } : {}),
        ...(i.selector ? { selector: i.selector } : {}),
        ...(i.detail ? { detail: i.detail } : {}),
      })),
    },
  }
}
