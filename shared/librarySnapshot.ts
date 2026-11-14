/**
 * The snapshot of a library item: its markup and everything it needs to
 * look the same elsewhere (the style rules that match it, keyframes, font
 * faces, custom properties, inherited text styles, and the SVG definitions
 * its `<use>` and `url(#…)` point at), read from a live document.
 *
 * One function for the two places that take it: the ⌘F preview iframe in
 * the browser (src/lib/findPreviewRuntime.ts appends its source as a
 * script) and the server's headless page (server/librarySnapshot.ts hands
 * the source to page.evaluate). It is inlined by source
 * (`LIBRARY_SNAPSHOT_SOURCE`), so it must not reference anything outside
 * its own body.
 *
 * The copy is inert: scripts, `on*` handlers, `javascript:` URLs,
 * `<iframe>`, `<object>`, `<embed>` and `<base>` are dropped.
 */

/** A library item as a document rendered it. */
export interface LibrarySnapshot {
  /** the item's markup, made inert */
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
  /** `<symbol>`, gradients, filters, clip paths and masks the item references */
  defs?: string[]
  /** false: the focus was not found and the whole document was taken */
  found: boolean
  /** the document runs scripts: behaviour they drive is lost in the copy */
  scripted: boolean
}

/** Read the snapshot of `target` (null: the whole body) in this document. */
export function takeLibrarySnapshot(target: Element | null): LibrarySnapshot {
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
  const UNSAFE_TAGS = 'script,iframe,object,embed,base,frame,frameset'
  const DEF_TAGS = ['symbol', 'lineargradient', 'radialgradient', 'filter', 'clippath', 'mask', 'pattern', 'marker']

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

  /* the copy runs nothing: no scripts, handlers, script URLs or embeds */
  function makeInert(root: Element) {
    for (const el of Array.from(root.querySelectorAll(UNSAFE_TAGS))) el.remove()
    for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
      for (const a of Array.from(el.attributes)) {
        const name = a.name.toLowerCase()
        /* browsers ignore whitespace and control characters in a URL scheme */
        let url = ''
        for (const ch of a.value) if (ch.charCodeAt(0) > 32) url += ch.toLowerCase()
        if (name.indexOf('on') === 0) el.removeAttribute(a.name)
        else if (/^(javascript|vbscript):/.test(url) || (url.indexOf('data:text/html') === 0 && name !== 'style'))
          el.removeAttribute(a.name)
      }
    }
  }

  /* the ids an element tree or a css text points at: <use href="#x">, url(#x) */
  function referencedIds(text: string): string[] {
    const ids: string[] = []
    for (const m of text.matchAll(/(?:href\s*=\s*["']#|url\(\s*["']?#)([\w:.-]+)/g)) if (m[1]) ids.push(m[1])
    return ids
  }

  function definitions(text: string, inside: Element): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    let todo = referencedIds(text)
    for (let round = 0; round < 3 && todo.length; round++) {
      const next: string[] = []
      for (const id of todo) {
        if (seen.has(id)) continue
        seen.add(id)
        let el: Element | null = null
        try {
          el = document.getElementById(id)
        } catch {
          el = null
        }
        /* defined inside the item already: it travels with it */
        if (!el || inside.contains(el)) continue
        const tag = el.tagName.toLowerCase()
        if (DEF_TAGS.indexOf(tag) < 0 && !el.closest('defs')) continue
        const copy = el.cloneNode(true) as Element
        makeInert(copy)
        const html = copy.outerHTML
        out.push(html)
        next.push(...referencedIds(html))
      }
      todo = next
    }
    return out
  }

  const found = !!target
  const el: Element = target ?? document.body
  /* a card often wraps its content in a frame of its own (.ex > .content) */
  const content = (found && el.querySelector(':scope > .content')) || el
  const clone = content.cloneNode(true) as Element
  makeInert(clone)
  const html = found ? clone.outerHTML : '<div>' + clone.innerHTML + '</div>'

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
  const inherited: [string, string][] = INHERITED.map((p) => [p, where.getPropertyValue(p)] as [string, string]).filter(
    ([, v]) => !!v,
  )

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
    defs: definitions(text, content),
    found,
    scripted: !!document.querySelector('script:not([data-doop-find])'),
  }
}

/** The function as source, for a document that cannot import it. */
export const LIBRARY_SNAPSHOT_SOURCE = takeLibrarySnapshot.toString()

/** A `<script>` defining `window.__doopLibrarySnapshot` from the source. */
export function librarySnapshotScript(): string {
  return `<script data-doop-find>window.__doopLibrarySnapshot=(${LIBRARY_SNAPSHOT_SOURCE});</script>`
}
