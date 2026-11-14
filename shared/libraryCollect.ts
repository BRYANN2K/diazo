/**
 * The DOM side of the library index: read a frame's variants from the
 * document its scripts built, each with its box. A scripted sheet only has
 * its cells once it ran, so this is what finds them (the static extractor
 * finds the family alone).
 *
 * The collector ships as a SOURCE STRING, like shared/slopCollect.ts: it
 * runs inside the server's headless page through page.evaluate. Keep it
 * self-contained ES5: no imports, no module-level helpers, no template
 * literals, no arrow functions.
 */

/** One variant as the rendered page shows it. */
export interface CollectedItem {
  id: string
  label: string
  /** the box of its design element, in document px */
  box: { x: number; y: number; w: number; h: number }
  /** the text the id stands in (what the preview runtime finds) */
  anchor: string
  /** the design element's data-doop-id, when it has one */
  elementId?: string
  /** its visible text, at most 2,000 characters */
  text: string
  /** its markup, at most 20,000 characters, for the content hash */
  html: string
}

export interface CollectedFrame {
  items: CollectedItem[]
  /** the document's own size */
  width: number
  height: number
  /** the deadline cut the walk short */
  timedOut: boolean
}

/** The variant rules the collector needs (LibraryRules.detect.variants). */
export interface CollectRules {
  mode: 'auto' | 'selectors' | 'none'
  cell?: string
  id?: string
  label?: string
  design?: string
  /** the family id, which is never one of its own variants */
  familyId?: string | null
}

/** `function collectLibraryItems(rules) { … }` as source. */
export const LIBRARY_COLLECTOR_SOURCE = `function collectLibraryItems(rules) {
  var DEADLINE = Date.now() + 5000
  var ID_RE = /^(?:[a-z0-9]+\\.)[a-z0-9]+(?:-[a-z0-9]+)*$/
  var LEGACY_RE = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/
  var out = []
  var timedOut = false
  var familyId = (rules && rules.familyId ? String(rules.familyId) : '').toLowerCase()
  function isId(text) {
    return text.length > 0 && text.length <= 120 && (ID_RE.test(text) || LEGACY_RE.test(text))
  }
  function squash(s) { return (s || '').replace(/\\s+/g, ' ').trim() }
  function boxOf(el) {
    var r = el.getBoundingClientRect()
    return { x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) }
  }
  function area(el) { var r = el.getBoundingClientRect(); return r.width * r.height }
  function q(root, sel) { try { return sel ? root.querySelector(sel) : null } catch (e) { return null } }
  function qa(root, sel) { try { return sel ? Array.prototype.slice.call(root.querySelectorAll(sel)) : [] } catch (e) { return [] } }
  function designOf(cell, idEl) {
    var best = null
    for (var i = 0; i < cell.children.length; i++) {
      var child = cell.children[i]
      if (child.contains(idEl)) continue
      if (!best || area(child) > area(best)) best = child
    }
    return best || cell
  }
  function labelOf(holder, id) {
    var text = squash(holder ? holder.textContent : '').replace(id, '')
    return text.replace(/^[\\s\\u00b7\\u2014\\u2013:-]+|[\\s\\u00b7\\u2014\\u2013:-]+$/g, '').trim()
  }
  function push(id, label, design) {
    if (!design) return
    var elementId = design.getAttribute('data-doop-id')
    var item = {
      id: id,
      label: label,
      box: boxOf(design),
      anchor: id,
      text: squash(design.innerText || design.textContent).slice(0, 2000),
      html: String(design.outerHTML || '').slice(0, 20000)
    }
    if (elementId) item.elementId = elementId
    out.push(item)
  }
  if (!document.body || !rules || rules.mode === 'none') {
    return { items: out, width: 0, height: 0, timedOut: false }
  }
  var marked = qa(document, '[data-doop-variant]')
  if (marked.length) {
    for (var m = 0; m < marked.length; m++) {
      var mid = marked[m].getAttribute('data-doop-variant') || ''
      if (isId(mid)) push(mid, marked[m].getAttribute('data-doop-name') || '', marked[m])
    }
  } else if (rules.mode === 'selectors') {
    var cells = qa(document, rules.cell)
    for (var c = 0; c < cells.length; c++) {
      if (Date.now() > DEADLINE) { timedOut = true; break }
      var idEl = q(cells[c], rules.id)
      var sid = idEl ? squash(idEl.textContent) : ''
      if (!idEl || !isId(sid)) continue
      var labelEl = rules.label ? q(cells[c], rules.label) : null
      var design = (rules.design && q(cells[c], rules.design)) || designOf(cells[c], idEl)
      push(sid, labelEl ? squash(labelEl.textContent) : labelOf(idEl.parentElement, sid), design)
    }
  } else {
    var found = []
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (var n = walker.nextNode(); n; n = walker.nextNode()) {
      if (Date.now() > DEADLINE) { timedOut = true; break }
      var text = squash(n.nodeValue)
      var parent = n.parentElement
      if (!parent || !text || text.indexOf('.') < 0 || !isId(text)) continue
      if (parent.closest('script,style,svg,template')) continue
      if (text.toLowerCase() === familyId) continue
      if (squash(parent.textContent) !== text) continue
      found.push({ el: parent, id: text })
    }
    var held = new Map()
    for (var f = 0; f < found.length; f++) {
      for (var p = found[f].el; p; p = p.parentElement) held.set(p, (held.get(p) || 0) + 1)
    }
    var seen = new Set()
    for (var g = 0; g < found.length; g++) {
      var child = found[g].el
      var up = child.parentElement
      while (up && (held.get(up) || 0) < 2) { child = up; up = up.parentElement }
      if (!up || up === document.documentElement || seen.has(child) || held.get(child) !== 1) continue
      seen.add(child)
      push(found[g].id, labelOf(found[g].el.parentElement, found[g].id), designOf(child, found[g].el))
    }
  }
  return {
    items: out,
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    timedOut: timedOut
  }
}`

/** The collector as an expression page.evaluate can run with these rules. */
export function collectExpression(rules: CollectRules): string {
  return `${LIBRARY_COLLECTOR_SOURCE}\n;collectLibraryItems(${JSON.stringify(rules)})`
}
