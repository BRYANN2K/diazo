/**
 * The DOM side of the frame checks (shared/frameChecks.ts): measurements the
 * headless renderer takes inside the frame's page.
 *
 * Shipped as SOURCE STRINGS, like shared/slopCollect.ts, because they run in
 * a page that cannot import modules — server/frameChecks.ts hands them to
 * page.evaluate. Keep them self-contained ES5: no imports, no module-scope
 * helpers, no template literals, no arrow functions.
 *
 * - collectViewportChecks(): overflow, clipped text, tap targets and text
 *   contrast at the current viewport width
 * - doopFocusSetup(): list the tabbable elements and remember how each one
 *   paints unfocused
 * - doopFocusStep(): after a real Tab key press, describe where focus landed
 *   and whether anything visible changed
 */
import type { FocusableInfo, FocusStep, ViewportSnapshot } from './frameChecks.ts'

/* the selector, label and visibility helpers both collectors need; inlined
   into each function body so every function stays self-contained */
const HELPERS = `
  function selectorFor(el) {
    var doopId = el.getAttribute('data-doop-id')
    if (doopId) return '[data-doop-id="' + doopId + '"]'
    if (el.id && el.id.length < 80) return '#' + el.id
    var parts = []
    var node = el
    while (node && node !== document.body && parts.length < 7) {
      var tag = node.tagName.toLowerCase()
      var parent = node.parentElement
      if (!parent) { parts.unshift(tag); break }
      var same = []
      for (var i = 0; i < parent.children.length; i++) {
        if (parent.children[i].tagName === node.tagName) same.push(parent.children[i])
      }
      parts.unshift(tag + (same.length > 1 ? ':nth-of-type(' + (same.indexOf(node) + 1) + ')' : ''))
      node = parent
    }
    return 'body > ' + parts.join(' > ')
  }
  function num(v, d) { var n = parseFloat(v); return isFinite(n) ? n : (d || 0) }
  function labelOf(el) {
    var t = el.getAttribute('aria-label') || (el.innerText || '').replace(/\\s+/g, ' ').trim() ||
      el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('placeholder') || ''
    if (!t && el.querySelector) {
      var img = el.querySelector('img[alt]')
      if (img) t = img.getAttribute('alt') || ''
    }
    return t.length > 40 ? t.slice(0, 39) + '…' : t
  }
  function shown(el, st, rect) {
    if (st.display === 'none' || st.visibility === 'hidden' || num(st.opacity, 1) === 0) return false
    if (rect.width < 1 || rect.height < 1) return false
    if (el.closest && el.closest('[aria-hidden="true"],[inert]')) return false
    return true
  }
  function rectOf(r) {
    return { x: r.left + (window.scrollX || 0), y: r.top + (window.scrollY || 0), w: r.width, h: r.height }
  }
`

/** `function collectViewportChecks() { … }` as source. */
export const VIEWPORT_CHECKS_SOURCE = `function collectViewportChecks() {
  ${HELPERS}
  var MAX_ELEMENTS = 1500
  var TAP_TAGS = /^(button|a|input|select|textarea|summary)$/
  var TAP_ROLES = /^(button|link|menuitem|tab|checkbox|radio|switch|option)$/
  var htmlEl = document.documentElement
  var vw = htmlEl.clientWidth
  function clipsX(st) { return st.overflowX !== 'visible' }
  function ownText(el) {
    var n = 0
    for (var i = 0; i < el.childNodes.length; i++) {
      var c = el.childNodes[i]
      if (c.nodeType === 3) n += (c.nodeValue || '').replace(/\\s+/g, '').length
    }
    return n
  }
  function hasAlpha(color) {
    var m = /rgba\\([^)]*,\\s*([\\d.]+)%?\\s*\\)/.exec(color || '')
    return m ? parseFloat(m[1]) > 0 : !!color && color !== 'transparent'
  }
  /* the first painted backdrop behind the element, or null when a gradient,
     image or filter in the chain makes a solid colour a guess */
  function backdropOf(el) {
    var node = el
    var hops = 0
    while (node && hops < 16) {
      var st = getComputedStyle(node)
      if ((st.backgroundImage || 'none') !== 'none') return null
      if ((st.filter || 'none') !== 'none' || (st.backdropFilter || 'none') !== 'none') return null
      var bg = st.backgroundColor || ''
      if (bg && hasAlpha(bg)) return bg
      node = node.parentElement
      hops++
    }
    return 'rgb(255, 255, 255)'
  }
  /* an element cut off or scrolled by an ancestor (other than html/body)
     cannot make the page overflow; html/body overflow-x:hidden hides it */
  function overflowContext(el) {
    var node = el.parentElement
    while (node && node !== document.body && node !== htmlEl) {
      if (clipsX(getComputedStyle(node))) return 'contained'
      node = node.parentElement
    }
    if (clipsX(getComputedStyle(document.body)) || clipsX(getComputedStyle(htmlEl))) return 'hidden'
    return 'page'
  }
  function inlineLink(el, st) {
    if (el.tagName !== 'A' || st.display !== 'inline') return false
    var p = el.parentElement
    if (!p) return false
    var own = (el.innerText || '').length
    var around = (p.innerText || '').length
    return around > own + 10
  }
  function rowOf(el, tag, r) {
    var row = { selector: selectorFor(el), tag: tag, rect: rectOf(r) }
    var id = el.getAttribute('data-doop-id')
    if (id) row.elementId = id
    var label = labelOf(el)
    if (label) row.label = label
    return row
  }
  var out = []
  var truncated = false
  var all = document.body ? document.body.querySelectorAll('*') : []
  for (var i = 0; i < all.length; i++) {
    if (out.length >= MAX_ELEMENTS) { truncated = true; break }
    var el = all[i]
    var tag = el.tagName.toLowerCase()
    if (/^(script|style|template|noscript|br|wbr|head|meta|link|title)$/.test(tag)) continue
    var st = getComputedStyle(el)
    var r = el.getBoundingClientRect()
    if (!shown(el, st, r)) continue
    var row = null
    /* overflow: the outermost element past the right edge */
    if (r.right > vw + 1 && st.position !== 'fixed') {
      var pr = el.parentElement && el.parentElement !== document.body ? el.parentElement.getBoundingClientRect() : null
      if (!pr || pr.right <= vw + 1) {
        var ctx = overflowContext(el)
        if (ctx !== 'contained') {
          (row = row || rowOf(el, tag, r)).overflowPx = r.right - vw
          if (ctx === 'hidden') row.overflowHidden = true
        }
      }
    }
    var text = ownText(el)
    /* clipped text: the box hides part of its own text */
    if (text > 0) {
      var hideX = st.overflowX === 'hidden' || st.overflowX === 'clip'
      var hideY = st.overflowY === 'hidden' || st.overflowY === 'clip'
      var intentional = st.textOverflow === 'ellipsis' || (st.webkitLineClamp && st.webkitLineClamp !== 'none')
      if (hideX && el.scrollWidth > el.clientWidth + 1) {
        (row = row || rowOf(el, tag, r)).clip = { axis: 'x', hiddenPx: el.scrollWidth - el.clientWidth, intentional: !!intentional }
      } else if (hideY && el.scrollHeight > el.clientHeight + 1) {
        (row = row || rowOf(el, tag, r)).clip = { axis: 'y', hiddenPx: el.scrollHeight - el.clientHeight, intentional: !!intentional }
      }
      var bg = backdropOf(el)
      if (bg) {
        (row = row || rowOf(el, tag, r)).contrast = { color: st.color, bg: bg, fontSizePx: num(st.fontSize), fontWeight: num(st.fontWeight, 400) }
      }
    }
    /* tap targets: a control's hit area, its wrapping label's when it has one */
    var role = el.getAttribute('role') || ''
    var tappable = (TAP_TAGS.test(tag) || TAP_ROLES.test(role)) && !el.disabled &&
      !(tag === 'a' && !el.hasAttribute('href')) && !(tag === 'input' && el.type === 'hidden')
    if (tappable && !inlineLink(el, st)) {
      var hit = r
      var label = el.closest ? el.closest('label') : null
      if (label && label !== el) {
        var lr = label.getBoundingClientRect()
        if (lr.width * lr.height > hit.width * hit.height) hit = lr
      }
      (row = row || rowOf(el, tag, r)).tap = { w: hit.width, h: hit.height }
    }
    if (row) out.push(row)
  }
  return {
    width: window.innerWidth,
    clientWidth: vw,
    scrollWidth: Math.max(htmlEl.scrollWidth, document.body ? document.body.scrollWidth : 0),
    elements: out,
    truncated: truncated,
  }
}`

/* how an element paints: everything a focus style usually changes, on the
   element and its ::before / ::after */
const SIGNATURE = `
  function paintOf(el) {
    var parts = []
    var targets = [getComputedStyle(el), getComputedStyle(el, '::before'), getComputedStyle(el, '::after')]
    for (var i = 0; i < targets.length; i++) {
      var s = targets[i]
      parts.push(
        s.outlineStyle === 'none' ? 'none' : s.outlineStyle + ' ' + s.outlineWidth + ' ' + s.outlineColor,
        s.boxShadow, s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor,
        s.borderTopWidth, s.backgroundColor, s.backgroundImage, s.color, s.textDecorationLine,
        s.opacity, s.transform, i > 0 ? s.content : ''
      )
    }
    return parts.join('|')
  }
`

/** `function doopFocusSetup() { … }` as source: blurs the page, lists the
 *  tabbable elements in DOM order and stores their unfocused paint. */
export const FOCUS_SETUP_SOURCE = `function doopFocusSetup() {
  ${HELPERS}
  ${SIGNATURE}
  var SELECTOR = 'a[href],area[href],button,input,select,textarea,summary,iframe,[tabindex],[contenteditable=""],[contenteditable="true"]'
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur()
  var list = []
  var paints = []
  var info = []
  var nodes = document.querySelectorAll(SELECTOR)
  for (var i = 0; i < nodes.length && list.length < 400; i++) {
    var el = nodes[i]
    if (el.disabled || (el.tagName === 'INPUT' && el.type === 'hidden')) continue
    var ti = el.tabIndex
    if (ti < 0) continue
    var st = getComputedStyle(el)
    if (!shown(el, st, el.getBoundingClientRect())) continue
    list.push(el)
    paints.push(paintOf(el))
    var row = { selector: selectorFor(el), tag: el.tagName.toLowerCase(), tabIndex: ti }
    var id = el.getAttribute('data-doop-id')
    if (id) row.elementId = id
    var label = labelOf(el)
    if (label) row.label = label
    info.push(row)
  }
  window.__doopFocus = { list: list, paints: paints, first: null }
  return info
}`

/** `function doopFocusStep() { … }` as source: where the last Tab press put
 *  focus, or null once focus left the document's elements or came back to
 *  where the walk started. */
export const FOCUS_STEP_SOURCE = `function doopFocusStep() {
  ${HELPERS}
  ${SIGNATURE}
  var state = window.__doopFocus
  var el = document.activeElement
  if (!state || !el || el === document.body || el === document.documentElement) return null
  if (state.first === el) return null
  if (!state.first) state.first = el
  var index = state.list.indexOf(el)
  var visibleChange = true
  if (index > -1) visibleChange = paintOf(el) !== state.paints[index]
  var step = {
    selector: selectorFor(el),
    tag: el.tagName.toLowerCase(),
    rect: rectOf(el.getBoundingClientRect()),
    index: index,
    visibleChange: visibleChange,
  }
  var id = el.getAttribute('data-doop-id')
  if (id) step.elementId = id
  var label = labelOf(el)
  if (label) step.label = label
  return step
}`

/** Expressions for page.evaluate: declaration + call. */
export const VIEWPORT_CHECKS_EXPR = `${VIEWPORT_CHECKS_SOURCE}\n;collectViewportChecks()`
export const FOCUS_SETUP_EXPR = `${FOCUS_SETUP_SOURCE}\n;doopFocusSetup()`
export const FOCUS_STEP_EXPR = `${FOCUS_STEP_SOURCE}\n;doopFocusStep()`

/* typed evaluators for hosts with a DOM at hand (jsdom tests) */
export function collectViewportChecks(): ViewportSnapshot {
  return new Function(`${VIEWPORT_CHECKS_SOURCE}; return collectViewportChecks()`)() as ViewportSnapshot
}
export function focusSetup(): FocusableInfo[] {
  return new Function(`${FOCUS_SETUP_SOURCE}; return doopFocusSetup()`)() as FocusableInfo[]
}
export function focusStep(): FocusStep | null {
  return new Function(`${FOCUS_STEP_SOURCE}; return doopFocusStep()`)() as FocusStep | null
}
