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

/** A library item as the preview rendered it: its markup and the CSS that
 *  styles it, read from the live document. */
export interface LibrarySnapshot {
  /** the item's markup, scripts left out */
  html: string
  /** its ancestors between the body and the item, outermost first: the copy
   *  keeps them as `display: contents` boxes, so descendant selectors match */
  ancestors: { tag: string; attrs: [string, string][] }[]
  /** classes and data attributes of <html> and <body>, for selectors such as `.dark .btn` */
  rootClasses: string[]
  rootAttrs: [string, string][]
  /** the style rules (and the @media / @supports around them) that match the item */
  rules: string[]
  keyframes: string[]
  fontFaces: string[]
  /** the custom properties the rules use, resolved where the item sits */
  vars: [string, string][]
  /** the inherited text styles the item had from above */
  inherited: [string, string][]
  /** false: the focus was not found and the whole document was taken */
  found: boolean
  /** the document runs scripts: behaviour they drive is lost in the copy */
  scripted: boolean
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

  /* ---- the snapshot an insert copies ---- */

  const STATE = /:(hover|focus|focus-visible|focus-within|active|visited|target)\b/g
  const PSEUDO_ELEMENT =
    /::?(before|after|placeholder|marker|selection|first-line|first-letter|backdrop|file-selector-button|-webkit-[\w-]+|-moz-[\w-]+)/g
  const INHERITED = [
    'color',
    'font-family',
    'font-size',
    'font-weight',
    'font-style',
    'line-height',
    'letter-spacing',
    '-webkit-font-smoothing',
    'text-rendering',
  ]

  /* split a selector list at its top-level commas */
  function selectorParts(list: string): string[] {
    const parts: string[] = []
    let depth = 0
    let start = 0
    for (let i = 0; i < list.length; i++) {
      const c = list[i]
      if (c === '(' || c === '[') depth++
      else if (c === ')' || c === ']') depth--
      else if (c === ',' && depth === 0) {
        parts.push(list.slice(start, i))
        start = i + 1
      }
    }
    parts.push(list.slice(start))
    return parts.map((p) => p.trim()).filter(Boolean)
  }

  /* does the rule style an element of the item, in any state? */
  function styles(selectorText: string, nodes: Element[]): boolean {
    for (const part of selectorParts(selectorText)) {
      let sel = part.replace(PSEUDO_ELEMENT, '').replace(STATE, '').trim()
      if (!sel || /[>+~]$/.test(sel)) sel = (sel + ' *').trim()
      try {
        for (const n of nodes) if (n.matches(sel)) return true
      } catch {
        /* a selector this engine cannot test is left out */
      }
    }
    return false
  }

  function header(rule: CSSRule): string {
    const text = rule.cssText
    return text.slice(0, text.indexOf('{')).trim()
  }

  function collect(
    rules: CSSRuleList,
    nodes: Element[],
    out: { rules: string[]; keyframes: Map<string, string>; fontFaces: string[] },
  ): string[] {
    const kept: string[] = []
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        if (styles(rule.selectorText, nodes)) kept.push(rule.cssText)
      } else if (rule instanceof CSSKeyframesRule) {
        out.keyframes.set(rule.name, rule.cssText)
      } else if (rule instanceof CSSFontFaceRule) {
        out.fontFaces.push(rule.cssText)
      } else if (rule instanceof CSSImportRule) {
        try {
          if (rule.styleSheet) kept.push(...collect(rule.styleSheet.cssRules, nodes, out))
        } catch {
          /* a sheet from another origin cannot be read */
        }
      } else if ('cssRules' in rule && (rule as CSSGroupingRule).cssRules) {
        /* @media, @supports, @container, @layer: kept around what they hold */
        const inner = collect((rule as CSSGroupingRule).cssRules, nodes, out)
        if (inner.length) kept.push(header(rule) + ' { ' + inner.join(' ') + ' }')
      }
    }
    return kept
  }

  function attrsOf(el: Element): [string, string][] {
    const attrs: [string, string][] = []
    for (const a of Array.from(el.attributes)) {
      const name = a.name.toLowerCase()
      if (name === 'id' || name === 'style' || name.indexOf('on') === 0 || name.indexOf('data-doop-') === 0) continue
      attrs.push([a.name, a.value])
    }
    return attrs
  }

  function snapshot(): LibrarySnapshot {
    const found = !!current
    const el: Element = current ?? document.body
    /* the item without the preview's own outline */
    const marked = current
    clear()
    /* a card often wraps its content in a frame of its own (.ex > .content) */
    const content = (found && el.querySelector(':scope > .content')) || el
    const clone = content.cloneNode(true) as Element
    for (const s of Array.from(clone.querySelectorAll('script'))) s.remove()
    const html = found ? clone.outerHTML : '<div>' + clone.innerHTML + '</div>'
    if (marked) mark(marked)

    const nodes = [content, ...Array.from(content.querySelectorAll('*'))]
    const out = { rules: [] as string[], keyframes: new Map<string, string>(), fontFaces: [] as string[] }
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        out.rules.push(...collect(sheet.cssRules, nodes, out))
      } catch {
        /* a sheet from another origin cannot be read */
      }
    }
    const text = out.rules.join('\n') + html

    const animations = new Set<string>()
    for (const m of text.matchAll(/animation(?:-name)?\s*:\s*([^;}"]+)/g)) {
      for (const word of (m[1] ?? '').split(/[\s,]+/)) if (word) animations.add(word)
    }
    for (const n of nodes) {
      const name = getComputedStyle(n).animationName
      if (name && name !== 'none') for (const word of name.split(/,\s*/)) animations.add(word)
    }
    const keyframes = [...out.keyframes].filter(([name]) => animations.has(name)).map(([, css]) => css)

    const families = new Set<string>()
    for (const n of nodes) {
      for (const f of getComputedStyle(n).fontFamily.split(',')) families.add(f.trim().replace(/^["']|["']$/g, ''))
    }
    const fontFaces = out.fontFaces.filter((css) => {
      const m = /font-family\s*:\s*["']?([^;"']+)/.exec(css)
      return !!m && families.has((m[1] ?? '').trim())
    })

    const where = getComputedStyle(content.parentElement ?? document.documentElement)
    const names = new Set<string>()
    for (const m of (text + keyframes.join('')).matchAll(/var\(\s*(--[\w-]+)/g)) if (m[1]) names.add(m[1])
    const vars: [string, string][] = []
    for (const name of names) {
      const value = where.getPropertyValue(name).trim()
      if (value) vars.push([name, value])
    }
    const inherited: [string, string][] = INHERITED.map(
      (p) => [p, where.getPropertyValue(p)] as [string, string],
    ).filter(([, v]) => !!v)

    const ancestors: LibrarySnapshot['ancestors'] = []
    if (found) {
      for (
        let a = content.parentElement;
        a && a !== document.body && a !== document.documentElement;
        a = a.parentElement
      ) {
        ancestors.unshift({ tag: a.tagName.toLowerCase(), attrs: attrsOf(a) })
      }
    }
    const roots = [document.documentElement, document.body].filter(Boolean)
    const rootClasses: string[] = []
    const rootAttrs: [string, string][] = []
    for (const r of roots) {
      for (const c of Array.from(r.classList)) rootClasses.push(c)
      for (const [name, value] of attrsOf(r)) if (name.indexOf('data-') === 0) rootAttrs.push([name, value])
    }

    return {
      html,
      ancestors,
      rootClasses,
      rootAttrs,
      rules: out.rules,
      keyframes,
      fontFaces,
      vars,
      inherited,
      found,
      scripted: !!document.querySelector('script:not([data-doop-find])'),
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== parent) return
    const data = e.data as { doopFindPreview?: string; focus?: string; snapshot?: string } | null
    if (!data || data.doopFindPreview !== token) return
    if (typeof data.snapshot === 'string') {
      post({ type: 'snapshot', request: data.snapshot, snapshot: snapshot() })
      return
    }
    if (typeof data.focus === 'string') focusOn(data.focus)
  })
  window.addEventListener('load', () => {
    post({ type: 'ready' })
    if (focus) focusOn(focus)
  })
}

/** The `<script>` the preview appends to the frame's document. */
export function findPreviewScript(token: string): string {
  return `<script data-doop-find>(${findPreviewRuntime.toString()})(${JSON.stringify(token)});</script>`
}

/** The frame's HTML with the preview script appended to its body. */
export function withFindPreviewScript(html: string, token: string): string {
  const script = findPreviewScript(token)
  return /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${script}</body>`) : html + script
}
