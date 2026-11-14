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

/** What the preview script posts to the parent. */
export interface FindPreviewMessage {
  doopFindPreview: string
  type: 'ready' | 'box'
  focus?: string
  box?: { x: number; y: number; w: number; h: number } | null
  docW?: number
  docH?: number
}

export function findPreviewRuntime(token: string): void {
  const OUTLINE = '3px solid #7c5cff'
  let current: HTMLElement | null = null
  let saved: { outline: string; outlineOffset: string; borderRadius: string } | null = null
  let focus = ''
  let retries: number[] = []

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
    const el = find(term)
    if (el) mark(el)
    const r = el ? el.getBoundingClientRect() : null
    post({
      type: 'box',
      focus: term,
      box: r ? { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height } : null,
    })
    return !!el
  }

  function focusOn(term: string) {
    focus = term
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

  window.addEventListener('message', (e) => {
    if (e.source !== parent) return
    const data = e.data as { doopFindPreview?: string; focus?: string } | null
    if (!data || data.doopFindPreview !== token || typeof data.focus !== 'string') return
    focusOn(data.focus)
  })
  window.addEventListener('load', () => {
    post({ type: 'ready' })
    if (focus) focusOn(focus)
  })
}

/** The `<script>` the preview appends to the frame's document. */
export function findPreviewScript(token: string): string {
  return `<script>(${findPreviewRuntime.toString()})(${JSON.stringify(token)});</script>`
}

/** The frame's HTML with the preview script appended to its body. */
export function withFindPreviewScript(html: string, token: string): string {
  const script = findPreviewScript(token)
  return /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${script}</body>`) : html + script
}
