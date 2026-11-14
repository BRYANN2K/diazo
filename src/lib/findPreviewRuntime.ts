/**
 * The ⌘F preview's script, run inside the sandboxed preview iframe (scripts
 * only, no same-origin). The iframe loads once per frame; the parent then
 * moves the focus with `postMessage({ doopFindPreview: token, focus })` and
 * this script swaps the outline onto the new element and posts its box back,
 * so hovering the result list never reloads a 300 KB library sheet.
 *
 * `findPreviewRuntime` is inlined by source (`toString()`): it must not
 * reference anything outside its own body.
 */

import { librarySnapshotScript, type LibrarySnapshot } from '../../shared/librarySnapshot'

export type { LibrarySnapshot }

/** Where the preview looks for an item: a selector (an element id) first,
 *  else the text, as is (a query) or as an id whose design is the cell's
 *  largest part (`anchor`). `key` tells two focuses apart. */
export interface ItemFocus {
  key: string
  text: string
  selector?: string
  anchor?: boolean
}

/** The focus of a text search: the text itself. */
export function textFocus(text: string): ItemFocus {
  return { key: text, text }
}

/** What the preview script posts to the parent. */
export interface FindPreviewMessage {
  doopFindPreview: string
  type: 'ready' | 'box' | 'snapshot'
  focus?: string
  box?: { x: number; y: number; w: number; h: number } | null
  docW?: number
  docH?: number
  /** the request a snapshot answers */
  request?: string
  snapshot?: LibrarySnapshot
}

export function findPreviewRuntime(token: string): void {
  const OUTLINE = '3px solid #7c5cff'
  let current: HTMLElement | null = null
  let saved: { outline: string; outlineOffset: string; borderRadius: string } | null = null
  let focus = ''
  let focusFind: { text: string; selector?: string; anchor?: boolean } = { text: '' }
  let retries: number[] = []
  const ID_TEXT = /^(?:[a-z0-9]+\.)[a-z0-9]+(?:-[a-z0-9]+)*$/

  /* the element carrying exactly this text, innermost */
  function exactText(term: string): HTMLElement | null {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const parent = n.parentElement
      if (!parent || (n.nodeValue ?? '').trim() !== term || parent.closest('script,style')) continue
      if ((parent.textContent ?? '').trim() === term) return parent
    }
    return null
  }

  /* how many id texts an element holds, stopping at two */
  function idsIn(el: Element): number {
    let count = 0
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n && count < 2; n = walker.nextNode()) {
      if (ID_TEXT.test((n.nodeValue ?? '').trim())) count++
    }
    return count
  }

  /* an id's design: the cell holding it is the child of the first ancestor
     holding another id; the design is the cell's largest part without the id */
  function design(term: string): HTMLElement | null {
    const idEl = exactText(term)
    if (!idEl) return null
    let cell: HTMLElement = idEl
    for (let up = idEl.parentElement; up && up !== document.body; up = up.parentElement) {
      if (idsIn(up) >= 2) break
      cell = up
    }
    let best: HTMLElement | null = null
    let bestArea = -1
    for (const child of Array.from(cell.children) as HTMLElement[]) {
      if (child.contains(idEl)) continue
      const r = child.getBoundingClientRect()
      if (r.width * r.height > bestArea) {
        best = child
        bestArea = r.width * r.height
      }
    }
    return best ?? cell
  }

  function locate(f: { text: string; selector?: string; anchor?: boolean }): HTMLElement | null {
    if (f.selector) {
      try {
        const el = document.querySelector(f.selector)
        if (el instanceof HTMLElement) return el
      } catch {
        /* not a selector this engine reads: the text is the fallback */
      }
    }
    if (f.anchor && f.text) {
      const el = design(f.text)
      if (el) return el
    }
    return find(f.text)
  }

  /* the smallest card-sized box around the first text holding the focus */
  function find(term: string): HTMLElement | null {
    if (!term || !document.body) return null
    const needle = term.toLowerCase()
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let hit: HTMLElement | null = null
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeValue && n.nodeValue.toLowerCase().indexOf(needle) >= 0 && n.parentElement) {
        if (n.parentElement.closest('script,style')) continue
        hit = n.parentElement
        break
      }
    }
    if (!hit) return null
    let el = hit
    let r = el.getBoundingClientRect()
    for (let i = 0; i < 8 && el.parentElement && el.parentElement !== document.body; i++) {
      if (r.width >= 160 && r.height >= 110) break
      el = el.parentElement
      r = el.getBoundingClientRect()
    }
    return el
  }

  function clear() {
    if (current && saved) {
      current.style.outline = saved.outline
      current.style.outlineOffset = saved.outlineOffset
      current.style.borderRadius = saved.borderRadius
    }
    current = null
    saved = null
  }

  function mark(el: HTMLElement) {
    saved = { outline: el.style.outline, outlineOffset: el.style.outlineOffset, borderRadius: el.style.borderRadius }
    el.style.outline = OUTLINE
    el.style.outlineOffset = '4px'
    if (!el.style.borderRadius) el.style.borderRadius = '6px'
    current = el
  }

  function post(message: Record<string, unknown>) {
    parent.postMessage(
      {
        doopFindPreview: token,
        docW: document.documentElement.scrollWidth,
        docH: document.documentElement.scrollHeight,
        ...message,
      },
      '*',
    )
  }

  function show(term: string): boolean {
    clear()
    const el = locate(focusFind)
    if (el) mark(el)
    const r = el ? el.getBoundingClientRect() : null
    post({
      type: 'box',
      focus: term,
      box: r ? { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height } : null,
    })
    return !!el
  }

  function focusOn(term: string, how?: { text: string; selector?: string; anchor?: boolean }) {
    focus = term
    focusFind = how ?? { text: term }
    for (const id of retries) clearTimeout(id)
    retries = []
    if (show(term)) return
    /* sheets often render their items from a script after load */
    for (const wait of [500, 1500]) {
      retries.push(
        window.setTimeout(() => {
          if (focus === term && !current) show(term)
        }, wait),
      )
    }
  }

  /* ---- the snapshot an insert copies ---- */

  /* taken by shared/librarySnapshot.ts, defined beside this script; the
     preview's own outline is lifted first, so it is not copied */
  function snapshot(): LibrarySnapshot {
    const marked = current
    clear()
    const take = (window as unknown as { __doopLibrarySnapshot: (el: Element | null) => LibrarySnapshot })
      .__doopLibrarySnapshot
    const snap = take(marked)
    if (marked) mark(marked)
    return snap
  }

  window.addEventListener('message', (e) => {
    if (e.source !== parent) return
    const data = e.data as {
      doopFindPreview?: string
      focus?: string
      find?: { text?: string; selector?: string; anchor?: boolean }
      snapshot?: string
    } | null
    if (!data || data.doopFindPreview !== token) return
    if (typeof data.snapshot === 'string') {
      post({ type: 'snapshot', request: data.snapshot, snapshot: snapshot() })
      return
    }
    if (typeof data.focus === 'string') {
      const how = data.find
      focusOn(
        data.focus,
        how && typeof how === 'object'
          ? {
              text: typeof how.text === 'string' ? how.text : data.focus,
              ...(typeof how.selector === 'string' ? { selector: how.selector } : {}),
              ...(how.anchor === true ? { anchor: true } : {}),
            }
          : undefined,
      )
    }
  })
  window.addEventListener('load', () => {
    post({ type: 'ready' })
    if (focus) focusOn(focus, focusFind)
  })
}

/** The `<script>` the preview appends to the frame's document. */
export function findPreviewScript(token: string): string {
  return `${librarySnapshotScript()}<script data-doop-find>(${findPreviewRuntime.toString()})(${JSON.stringify(token)});</script>`
}

/** The frame's HTML with the preview script appended to its body. */
export function withFindPreviewScript(html: string, token: string): string {
  const script = findPreviewScript(token)
  return /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${script}</body>`) : html + script
}
