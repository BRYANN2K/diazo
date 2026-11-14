/**
 * Which part of a frame a library item's thumbnail shows: the item's demo,
 * not the sheet's chrome around it.
 *
 * A library card is usually a label strip (`id — label`), the demo box that
 * holds the rendered component, and a caption or meta row. The page probe
 * (a SOURCE STRING run in the headless page, like shared/libraryCollect.ts:
 * self-contained ES5, no imports, no arrow functions, no template literals)
 * finds the item's element and returns a pruned tree of its visible
 * descendants with their boxes and a few flags; `chooseThumbClip`, a pure
 * function, walks that tree down to the demo.
 */

export interface ThumbRect {
  x: number
  y: number
  w: number
  h: number
}

/** One visible element of the probed tree. */
export interface ThumbNode {
  /** its box, in document px */
  r: ThumbRect
  /** only text: no image, svg, canvas, video or painted box inside it */
  t: boolean
  /** its text names the item's id (a label strip or a caption, when text alone) */
  id: boolean
  c: ThumbNode[]
}

/** What the probe needs to find the item's element. */
export interface ThumbTarget {
  itemId: string
  /** the item's box from the rendered pass, if it has one */
  box: ThumbRect | null
  /** the element's data-doop-id, when the locator has one */
  elementId?: string
  /** the text the id stands in (a variant of a sheet) */
  anchor?: string
}

export interface ThumbProbe {
  root: ThumbNode | null
  /** the document's own size */
  width: number
  height: number
}

/** A caption or meta row: text alone, short next to its parent. */
const CAPTION_MAX_PX = 96
const CAPTION_SHARE = 0.2
/** a single child this much of its parent is the parent's content */
const FILLS = 0.5

const area = (r: ThumbRect) => Math.max(0, r.w) * Math.max(0, r.h)

function union(rects: ThumbRect[]): ThumbRect {
  const x = Math.min(...rects.map((r) => r.x))
  const y = Math.min(...rects.map((r) => r.y))
  const right = Math.max(...rects.map((r) => r.x + r.w))
  const bottom = Math.max(...rects.map((r) => r.y + r.h))
  return { x, y, w: right - x, h: bottom - y }
}

function isCaption(node: ThumbNode, parent: ThumbNode): boolean {
  return node.t && (node.r.h <= CAPTION_MAX_PX || node.r.h <= parent.r.h * CAPTION_SHARE)
}

/** The children that are content, and whether any chrome was set aside. */
function contentOf(node: ThumbNode): { kids: ThumbNode[]; dropped: boolean } {
  const visible = node.c.filter((k) => area(k.r) > 0)
  /* the label strip: text alone that names the item (a box holding the demo
     and a caption naming it is content) */
  const rest = visible.filter((k) => !(k.id && k.t))
  const substantial = rest.filter((k) => !isCaption(k, node))
  const kids = substantial.length ? substantial : rest
  return { kids, dropped: kids.length < visible.length }
}

/**
 * The demo's box: walk down from the item's element, setting aside the
 * label strip (its text names the item) and the caption rows (short text),
 * into the one child that is left, until the content is several elements
 * (their union) or one element with nothing to set aside that does not fill
 * its parent (the demo box itself, kept with its own background).
 */
export function chooseThumbClip(root: ThumbNode): ThumbRect {
  let node = root
  for (let depth = 0; depth < 12; depth++) {
    const { kids, dropped } = contentOf(node)
    if (!kids.length) return node.r
    if (kids.length > 1) return dropped ? union(kids.map((k) => k.r)) : node.r
    const only = kids[0]!
    if (!dropped && area(only.r) < area(node.r) * FILLS) return node.r
    node = only
  }
  return node.r
}

/** Round a clip to whole px, at least 1x1. `inward` keeps a fractional
 *  edge inside the box, so a neighbour's border never creeps in. */
export function roundClip(r: ThumbRect, inward = false): { x: number; y: number; width: number; height: number } {
  const x = Math.max(0, inward ? Math.ceil(r.x) : Math.floor(r.x))
  const y = Math.max(0, inward ? Math.ceil(r.y) : Math.floor(r.y))
  const right = inward ? Math.floor(r.x + r.w) : Math.ceil(r.x + r.w)
  const bottom = inward ? Math.floor(r.y + r.h) : Math.ceil(r.y + r.h)
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) }
}

/** `function probeThumb(target) { … }` as source. */
export const THUMB_PROBE_SOURCE = `function probeThumb(target) {
  var ID_RE = /\\b[a-z0-9]+\\.[a-z0-9]+(?:-[a-z0-9]+)+\\b/i
  var MEDIA = { IMG: 1, SVG: 1, CANVAS: 1, VIDEO: 1, IFRAME: 1, PICTURE: 1, OBJECT: 1, EMBED: 1 }
  var SKIP = { SCRIPT: 1, STYLE: 1, TEMPLATE: 1, NOSCRIPT: 1, LINK: 1, META: 1, HEAD: 1 }
  var itemId = String(target.itemId || '').toLowerCase()
  var MAX_DEPTH = 9
  var MAX_KIDS = 40
  var count = 0
  function squash(s) { return (s || '').replace(/\\s+/g, ' ').trim() }
  function rectOf(el) {
    var r = el.getBoundingClientRect()
    return { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height }
  }
  function visible(el) {
    if (SKIP[el.tagName]) return false
    var s = getComputedStyle(el)
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false
    var r = el.getBoundingClientRect()
    return r.width > 1 && r.height > 1
  }
  function paints(el) {
    if (MEDIA[el.tagName.toUpperCase()]) return true
    var s = getComputedStyle(el)
    if (s.backgroundImage && s.backgroundImage !== 'none') return true
    if (s.boxShadow && s.boxShadow !== 'none') return true
    var bg = s.backgroundColor
    if (bg && bg !== 'transparent' && !/rgba\\(\\d+, \\d+, \\d+, 0\\)/.test(bg)) return true
    return parseFloat(s.borderTopWidth) > 0 || parseFloat(s.borderLeftWidth) > 0
  }
  function names(el) {
    if (!itemId) return false
    return squash(el.textContent).toLowerCase().indexOf(itemId) >= 0
  }
  function node(el, depth) {
    count++
    var kids = []
    var textOnly = true
    var children = el.children
    for (var i = 0; i < children.length; i++) {
      var child = children[i]
      if (!visible(child)) continue
      if (depth < MAX_DEPTH && kids.length < MAX_KIDS && count < 2000) {
        var sub = node(child, depth + 1)
        kids.push(sub)
        if (!sub.t || paints(child)) textOnly = false
      } else if (paints(child) || child.querySelector('img,svg,canvas,video,iframe,picture')) {
        textOnly = false
      }
    }
    if (MEDIA[el.tagName.toUpperCase()]) textOnly = false
    return { r: rectOf(el), t: textOnly, id: names(el), c: kids }
  }
  function overlap(a, b) {
    var x = Math.max(a.x, b.x)
    var y = Math.max(a.y, b.y)
    var w = Math.min(a.x + a.w, b.x + b.w) - x
    var h = Math.min(a.y + a.h, b.y + b.h) - y
    if (w <= 0 || h <= 0) return 0
    var inter = w * h
    return inter / (a.w * a.h + b.w * b.h - inter)
  }
  function byBox(box) {
    var best = null
    var bestScore = 0.85
    var all = document.body.getElementsByTagName('*')
    for (var i = 0; i < all.length && i < 6000; i++) {
      var el = all[i]
      if (SKIP[el.tagName]) continue
      var score = overlap(rectOf(el), box)
      /* the deepest of equally good matches: document order visits it later */
      if (score >= bestScore) { best = el; bestScore = score }
    }
    return best
  }
  function byAnchor(anchor) {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (var n = walker.nextNode(); n; n = walker.nextNode()) {
      if (squash(n.nodeValue) !== anchor || !n.parentElement) continue
      var cell = n.parentElement
      /* climb to the cell: the last ancestor naming no other item */
      while (cell.parentElement && cell.parentElement !== document.body) {
        var text = squash(cell.parentElement.textContent).replace(anchor, '')
        if (ID_RE.test(text)) break
        cell = cell.parentElement
      }
      return cell
    }
    return null
  }
  var root = null
  if (document.body) {
    if (target.elementId) {
      try { root = document.querySelector('[data-doop-id="' + CSS.escape(target.elementId) + '"]') } catch (e) { root = null }
    }
    if (!root && target.box) root = byBox(target.box)
    if (!root && target.anchor) root = byAnchor(target.anchor)
    if (!root || root === document.documentElement) root = document.body
  }
  return {
    root: root ? node(root, 0) : null,
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight
  }
}`

/** The probe as an expression page.evaluate can run for this target. */
export function probeExpression(target: ThumbTarget): string {
  return `${THUMB_PROBE_SOURCE}\n;probeThumb(${JSON.stringify(target)})`
}

/**
 * Wakes a demo before its picture is taken (as source): CSS and Web
 * Animations that run once jump to their end, looping ones to 40 % of an
 * iteration, so neither shows its blank first frame.
 */
export const SETTLE_ANIMATIONS_SOURCE = `(function () {
  if (!document.getAnimations) return 0
  var list = document.getAnimations()
  var moved = 0
  for (var i = 0; i < list.length; i++) {
    var a = list[i]
    try {
      var timing = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null
      if (!timing) continue
      var duration = Number(timing.duration) || 0
      var delay = Number(timing.delay) || 0
      if (timing.iterations === Infinity) {
        if (duration > 0) { a.currentTime = delay + duration * 0.4; moved++ }
      } else if (isFinite(timing.endTime)) {
        a.finish()
        moved++
      }
    } catch (e) { /* an animation that refuses to seek keeps playing */ }
  }
  return moved
})()`

/** Waits for the page's fonts (bounded) and two animation frames (as source). */
export const FONTS_READY_SOURCE = `new Promise(function (resolve) {
  var done = false
  function finish() { if (done) return; done = true; requestAnimationFrame(function () { requestAnimationFrame(function () { resolve(true) }) }) }
  setTimeout(finish, 1500)
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(finish, finish)
  else finish()
})`
