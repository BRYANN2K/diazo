/**
 * Frame checks: responsive and accessibility audits of a frame's rendered
 * document, scored from what the headless renderer measured.
 *
 * The renderer (server/frameChecks.ts) loads the frame once, lays it out at
 * each width of FRAME_CHECK_WIDTHS and runs the collector
 * (shared/frameChecksCollect.ts) there, then walks the page with the Tab key
 * for the focus audit. This file turns those measurements into a FrameChecks
 * verdict: pure functions, no DOM, the same on server and client.
 *
 * The anti-slop lint (shared/slopRules.ts) reads one rendering at the frame's
 * own width; these checks answer the questions one rendering cannot — does
 * the layout survive a phone, are the controls touchable, does a keyboard
 * user see where focus is.
 */
import { contrastRatio, cssColorToRgba } from './slopRules.ts'

export type FrameCheckSeverity = 'error' | 'warning'

export type FrameCheckRuleId =
  'FC-OVERFLOW' | 'FC-CLIP' | 'FC-TAP' | 'FC-CONTRAST' | 'FC-FOCUS-VISIBLE' | 'FC-TAB-ORDER' | 'FC-TAB-REACH'

export interface FrameCheckRule {
  id: FrameCheckRuleId
  severity: FrameCheckSeverity
  title: string
}

export const FRAME_CHECK_RULES: FrameCheckRule[] = [
  { id: 'FC-OVERFLOW', severity: 'error', title: 'Horizontal overflow' },
  { id: 'FC-CLIP', severity: 'warning', title: 'Clipped text' },
  { id: 'FC-TAP', severity: 'warning', title: 'Tap target under 44px' },
  { id: 'FC-CONTRAST', severity: 'error', title: 'Text contrast below WCAG AA' },
  { id: 'FC-FOCUS-VISIBLE', severity: 'error', title: 'No visible keyboard focus' },
  { id: 'FC-TAB-ORDER', severity: 'warning', title: 'Tab order' },
  { id: 'FC-TAB-REACH', severity: 'warning', title: 'Unreachable by keyboard' },
]

/** The widths every frame is laid out at: phone, tablet, desktop. */
export const FRAME_CHECK_WIDTHS = [375, 768, 1440] as const

/** The viewport height that goes with each width (vh units and fixed bars
 *  lay out against it). */
export function viewportHeightFor(width: number): number {
  if (width <= 480) return 812
  if (width <= 1024) return 1024
  return 900
}

/** Below this width the layout is a touch layout and tap targets count. */
export const TOUCH_WIDTH_MAX = 1024

/** WCAG 2.5.5 (AAA) / Apple HIG minimum touch target. */
export const TAP_TARGET_MIN_PX = 44

/** The width the keyboard walk runs at. */
export const FOCUS_AUDIT_WIDTH = 1440

/** Bump when check behaviour changes, so stale results are recognizable. */
export const FRAME_CHECKS_VERSION = 1

export interface FrameCheckIssue {
  ruleId: FrameCheckRuleId
  severity: FrameCheckSeverity
  message: string
  /** the widths the issue shows at; empty for the keyboard audit */
  widths: number[]
  elementId?: string
  selector?: string
  detail?: string
}

export interface FrameViewportSummary {
  width: number
  /** how far the document scrolls sideways past the viewport, in px */
  overflowPx: number
  /** issues found at this width (after merging, an issue counts at every width it shows at) */
  issues: number
}

export interface FrameFocusSummary {
  /** visible, tabbable elements in the document */
  focusables: number
  /** distinct elements the Tab walk landed on */
  reached: number
  /** of those, how many showed no visible change when focused */
  withoutVisibleFocus: number
}

export interface FrameChecks {
  /** 100 minus deductions, floored at 0 */
  score: number
  errors: number
  warnings: number
  issues: FrameCheckIssue[]
  viewports: FrameViewportSummary[]
  /** null when the keyboard walk could not run */
  focus: FrameFocusSummary | null
  /** fingerprint of the html the checks measured (htmlFingerprint) */
  htmlHash: string
  checkedAt: number
  version: number
  /** an element walk hit its cap — a very large document may not be fully checked */
  truncated?: boolean
}

/* ---- what the collector measures at one width ---- */

export interface CheckRect {
  x: number
  y: number
  w: number
  h: number
}

export interface CheckElement {
  selector: string
  elementId?: string
  tag: string
  /** a short label for messages: visible text, aria-label or alt */
  label?: string
  rect: CheckRect
  /** px the element sticks out past the viewport's right edge (outermost offender only) */
  overflowPx?: number
  /** the overflow is cut off by html/body overflow-x:hidden rather than scrolling */
  overflowHidden?: boolean
  /** text cut off by its own box */
  clip?: { axis: 'x' | 'y'; hiddenPx: number; intentional: boolean }
  /** an interactive element, with its effective hit area */
  tap?: { w: number; h: number }
  /** text on an opaque, solid backdrop */
  contrast?: { color: string; bg: string; fontSizePx: number; fontWeight: number }
}

export interface ViewportSnapshot {
  width: number
  clientWidth: number
  scrollWidth: number
  elements: CheckElement[]
  truncated?: boolean
}

/* ---- what the keyboard walk records ---- */

export interface FocusableInfo {
  selector: string
  elementId?: string
  tag: string
  label?: string
  tabIndex: number
}

export interface FocusStep {
  selector: string
  elementId?: string
  tag: string
  label?: string
  rect: CheckRect
  /** index in the focusables list, -1 when the element was not in it */
  index: number
  /** some painted property (outline, shadow, border, background, colour,
   *  underline, a pseudo-element) differs from the unfocused state */
  visibleChange: boolean
}

export interface FocusAudit {
  focusables: FocusableInfo[]
  steps: FocusStep[]
  /** the walk came back to its start (or to the page) before the cap */
  wrapped: boolean
}

/* ------------------------------------------------------------------ */

const MAX_ISSUES_PER_RULE = 8
const MAX_ISSUES = 60

type Rgba = NonNullable<ReturnType<typeof cssColorToRgba>>

/** `top` composited over an opaque `bottom`. */
function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  }
}

/** WCAG contrast of text `color` on backdrop `bg` (rgb()/rgba() strings),
 *  translucent layers composited over white. Null when a colour won't parse. */
export function textContrast(color: string, bg: string): number | null {
  const fgRaw = cssColorToRgba(color)
  const bgRaw = cssColorToRgba(bg)
  if (!fgRaw || !bgRaw) return null
  const white = { r: 255, g: 255, b: 255, a: 1 }
  const back = bgRaw.a < 1 ? over(bgRaw, white) : bgRaw
  const fore = fgRaw.a < 1 ? over(fgRaw, back) : fgRaw
  return contrastRatio(fore, back)
}

/** WCAG large text: 24px, or 18.66px bold. */
export function isLargeText(fontSizePx: number, fontWeight: number): boolean {
  return fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700)
}

/** A short, stable fingerprint of a document (FNV-1a, 32 bit, plus length),
 *  so a re-run on unchanged html can be skipped. */
export function htmlFingerprint(html: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < html.length; i++) {
    h ^= html.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `${(h >>> 0).toString(16).padStart(8, '0')}-${html.length.toString(36)}`
}

function rule(id: FrameCheckRuleId): FrameCheckRule {
  const r = FRAME_CHECK_RULES.find((x) => x.id === id)
  if (!r) throw new Error(`unknown frame check ${id}`)
  return r
}

function named(el: { tag: string; label?: string }): string {
  return el.label ? `${el.tag} "${el.label}"` : el.tag
}

interface Draft {
  ruleId: FrameCheckRuleId
  message: string
  width?: number
  elementId?: string
  selector?: string
  detail?: string
}

/** Merge per-width findings: the same rule on the same element is one issue
 *  listing every width it shows at (the first width's wording wins). */
function merge(drafts: Draft[]): FrameCheckIssue[] {
  const byKey = new Map<string, FrameCheckIssue>()
  const perRule = new Map<string, number>()
  const out: FrameCheckIssue[] = []
  for (const d of drafts) {
    const key = `${d.ruleId}|${d.selector ?? d.message}`
    const existing = byKey.get(key)
    if (existing) {
      if (d.width !== undefined && !existing.widths.includes(d.width)) existing.widths.push(d.width)
      continue
    }
    if (out.length >= MAX_ISSUES) continue
    const seen = perRule.get(d.ruleId) ?? 0
    if (seen >= MAX_ISSUES_PER_RULE) continue
    perRule.set(d.ruleId, seen + 1)
    const issue: FrameCheckIssue = {
      ruleId: d.ruleId,
      severity: rule(d.ruleId).severity,
      message: d.message,
      widths: d.width === undefined ? [] : [d.width],
      ...(d.elementId ? { elementId: d.elementId } : {}),
      ...(d.selector ? { selector: d.selector } : {}),
      ...(d.detail ? { detail: d.detail } : {}),
    }
    byKey.set(key, issue)
    out.push(issue)
  }
  for (const issue of out) issue.widths.sort((a, b) => a - b)
  return out
}

/** Findings at one width. */
export function checkViewport(snap: ViewportSnapshot): Draft[] {
  const drafts: Draft[] = []
  const width = snap.width
  const at = (el: CheckElement) => ({
    width,
    selector: el.selector,
    ...(el.elementId ? { elementId: el.elementId } : {}),
  })
  for (const el of snap.elements) {
    if (el.overflowPx !== undefined && el.overflowPx > 1) {
      const px = Math.round(el.overflowPx)
      drafts.push({
        ruleId: 'FC-OVERFLOW',
        message: el.overflowHidden
          ? `${named(el)} runs ${px}px past the screen edge and is cut off`
          : `${named(el)} runs ${px}px past the screen edge (page scrolls sideways)`,
        detail: `${px}px at ${width}px`,
        ...at(el),
      })
    }
    if (el.clip && el.clip.hiddenPx > 1) {
      const px = Math.round(el.clip.hiddenPx)
      drafts.push({
        ruleId: 'FC-CLIP',
        message: el.clip.intentional
          ? `${named(el)} text is truncated (${px}px hidden)`
          : `${named(el)} text is clipped by its box (${px}px hidden ${el.clip.axis === 'x' ? 'sideways' : 'below'})`,
        detail: `${px}px ${el.clip.axis}`,
        ...at(el),
      })
    }
    if (el.tap && width < TOUCH_WIDTH_MAX) {
      const { w, h } = el.tap
      if (w < TAP_TARGET_MIN_PX || h < TAP_TARGET_MIN_PX) {
        drafts.push({
          ruleId: 'FC-TAP',
          message: `${named(el)} tap target is ${Math.round(w)}×${Math.round(h)}px (needs ${TAP_TARGET_MIN_PX}×${TAP_TARGET_MIN_PX})`,
          detail: `${Math.round(w)}×${Math.round(h)}`,
          ...at(el),
        })
      }
    }
    if (el.contrast) {
      const { color, bg, fontSizePx, fontWeight } = el.contrast
      const ratio = textContrast(color, bg)
      const floor = isLargeText(fontSizePx, fontWeight) ? 3 : 4.5
      if (ratio !== null && ratio < floor) {
        drafts.push({
          ruleId: 'FC-CONTRAST',
          message: `${named(el)} text has ${ratio.toFixed(2)}:1 contrast (AA needs ${floor}:1)`,
          detail: `${color} on ${bg}`,
          ...at(el),
        })
      }
    }
  }
  /* a page that scrolls sideways with no single element to blame (negative
     margins, 100vw plus a scrollbar…) still fails */
  const docOverflow = snap.scrollWidth - snap.clientWidth
  if (docOverflow > 1 && !drafts.some((d) => d.ruleId === 'FC-OVERFLOW')) {
    drafts.push({
      ruleId: 'FC-OVERFLOW',
      message: `the page scrolls ${Math.round(docOverflow)}px sideways`,
      detail: `${Math.round(docOverflow)}px at ${width}px`,
      width,
    })
  }
  return drafts
}

/** Findings of the keyboard walk. */
export function checkFocus(audit: FocusAudit): { drafts: Draft[]; summary: FrameFocusSummary } {
  const drafts: Draft[] = []
  const reached = new Set<string>()
  const invisible = new Set<string>()
  const ref = (el: { selector: string; elementId?: string }) => ({
    selector: el.selector,
    ...(el.elementId ? { elementId: el.elementId } : {}),
  })
  for (const f of audit.focusables) {
    if (f.tabIndex > 0) {
      drafts.push({
        ruleId: 'FC-TAB-ORDER',
        message: `${named(f)} has tabindex="${f.tabIndex}", which overrides the document's tab order`,
        detail: `tabindex ${f.tabIndex}`,
        ...ref(f),
      })
    }
  }
  let prev: FocusStep | undefined
  for (const step of audit.steps) {
    reached.add(step.selector)
    if (!step.visibleChange && !invisible.has(step.selector)) {
      invisible.add(step.selector)
      drafts.push({
        ruleId: 'FC-FOCUS-VISIBLE',
        message: `${named(step)} shows no visible change when it gets keyboard focus`,
        ...ref(step),
      })
    }
    /* reading order: the next stop sits wholly above the previous one and
       not in a column to its right — focus jumps back up the page */
    if (prev) {
      const up = step.rect.y + step.rect.h <= prev.rect.y - 4
      const rightColumn = step.rect.x >= prev.rect.x + prev.rect.w
      if (up && !rightColumn) {
        drafts.push({
          ruleId: 'FC-TAB-ORDER',
          message: `Tab moves from ${named(prev)} back up to ${named(step)}, against the visual order`,
          detail: `y ${Math.round(prev.rect.y)} → ${Math.round(step.rect.y)}`,
          ...ref(step),
        })
      }
    }
    prev = step
  }
  if (audit.wrapped) {
    const missed = audit.focusables.filter((f) => f.tabIndex >= 0 && !reached.has(f.selector))
    if (missed.length > 0) {
      const first = missed[0]!
      drafts.push({
        ruleId: 'FC-TAB-REACH',
        message:
          missed.length === 1
            ? `${named(first)} is focusable but Tab never reaches it`
            : `${missed.length} focusable elements are never reached by Tab (first: ${named(first)})`,
        ...ref(first),
      })
    }
  }
  return {
    drafts,
    summary: {
      focusables: audit.focusables.length,
      reached: reached.size,
      withoutVisibleFocus: invisible.size,
    },
  }
}

/** Score the renderer's measurements: every width plus the keyboard walk. */
export function scoreFrameChecks(input: {
  viewports: ViewportSnapshot[]
  focus: FocusAudit | null
  htmlHash: string
  checkedAt?: number
}): FrameChecks {
  const drafts: Draft[] = []
  for (const vp of input.viewports) drafts.push(...checkViewport(vp))
  const focus = input.focus ? checkFocus(input.focus) : null
  if (focus) drafts.push(...focus.drafts)
  const issues = merge(drafts)
  const errors = issues.filter((i) => i.severity === 'error').length
  const warnings = issues.length - errors
  const viewports = input.viewports.map((vp) => ({
    width: vp.width,
    overflowPx: Math.max(0, Math.round(vp.scrollWidth - vp.clientWidth)),
    issues: issues.filter((i) => i.widths.includes(vp.width)).length,
  }))
  const truncated = input.viewports.some((vp) => vp.truncated)
  return {
    score: Math.max(0, 100 - errors * 15 - warnings * 4),
    errors,
    warnings,
    issues,
    viewports,
    focus: focus ? focus.summary : null,
    htmlHash: input.htmlHash,
    checkedAt: input.checkedAt ?? Date.now(),
    version: FRAME_CHECKS_VERSION,
    ...(truncated ? { truncated: true } : {}),
  }
}

/** One line for prose reports. */
export function frameChecksSummary(checks: FrameChecks): string {
  if (checks.issues.length === 0) return `frame checks clean at ${checks.viewports.map((v) => v.width).join('/')}`
  return `frame checks score ${checks.score}: ${checks.errors} error(s), ${checks.warnings} warning(s)`
}
