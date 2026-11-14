import { parse, type DefaultTreeAdapterTypes as Tree } from 'parse5'
import { instancesIn } from './componentActions.ts'
import { CSS_ATTR, INSTANCE_ATTR } from '../shared/components.ts'
import { TOKEN_BLOCK_ATTR, type DesignToken } from '../shared/designTokens.ts'
import { codePathProblem, normalizeCodePath, type CodeLink } from '../shared/codeLinks.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/* Frame → code (feat/frame-to-code): a frame's HTML becomes one React or
 * Astro component in the linked repo's own terms — raw values that equal a
 * design token become `var(--token)`, component instances whose component
 * is mapped to a file (code_links) become that component, imported from its
 * file. Deterministic: the same frame, tokens and mapping always give the
 * same files, so the write route can rebuild what the preview showed. */

export const FRAME_CODE_FRAMEWORKS = ['react', 'astro'] as const
export type FrameCodeFramework = (typeof FRAME_CODE_FRAMEWORKS)[number]

export interface FrameCodeOptions {
  framework: FrameCodeFramework
  /** repo-relative output file; defaults to the frame's mapping or src/components/<Name> */
  path?: string
  /** the component's export name; defaults to the frame name, PascalCased */
  name?: string
}

export interface FrameCodeFile {
  path: string
  text: string
}

export interface FrameCode {
  framework: FrameCodeFramework
  name: string
  /** the component file first; React adds a sibling stylesheet */
  files: FrameCodeFile[]
  /** components imported through their mapping */
  imports: { component: string; name: string; from: string }[]
  /** components the frame uses that have no mapping — inlined as markup */
  unmapped: string[]
  /** tokens the output names */
  tokens: string[]
  /** scripts the frame carried, left out of the component */
  droppedScripts: number
}

export class FrameCodeError extends Error {}

/* ------------------------------------------------------------------ */
/* naming and paths                                                    */
/* ------------------------------------------------------------------ */

export function componentNameFor(raw: string): string {
  const words = raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
  const name = words
    .map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
    .join('')
    .replace(/^\d+/, '')
  return name || 'Screen'
}

const EXT: Record<FrameCodeFramework, string> = { react: '.tsx', astro: '.astro' }

export function defaultFramePath(name: string, framework: FrameCodeFramework): string {
  return `src/components/${name}${EXT[framework]}`
}

/** The import specifier for `target` as seen from `from` (both repo-relative). */
export function relativeImport(from: string, target: string): string {
  const fromDir = from.split('/').slice(0, -1)
  const to = target.split('/')
  let common = 0
  while (common < fromDir.length && common < to.length - 1 && fromDir[common] === to[common]) common++
  const up = fromDir.length - common
  const rest = to.slice(common).join('/')
  const spec = (up ? '../'.repeat(up) : './') + rest
  /* script modules are imported without their extension; single-file components keep it */
  return spec.replace(/\.(tsx|ts|jsx|js|mjs)$/, '').replace(/\/index$/, '')
}

/* ------------------------------------------------------------------ */
/* tokens                                                              */
/* ------------------------------------------------------------------ */

const normValue = (v: string) => v.trim().toLowerCase().replace(/\s+/g, ' ')

/** Raw value → token name, for exact matches only; aliases are skipped. */
function tokenIndex(tokens: readonly DesignToken[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const t of [...tokens].sort((a, b) => a.order - b.order)) {
    if (t.value.startsWith('var(')) continue
    const key = normValue(t.value)
    if (key && !out.has(key)) out.set(key, t.name)
  }
  return out
}

/** Swap each declaration value that equals a token for `var(--token)`. */
export function substituteTokens(css: string, index: Map<string, string>, used: Set<string>): string {
  return css.replace(
    /(^|[{;\s])([a-z-]+)\s*:\s*([^;{}]+?)(\s*)(?=;|}|$)/gim,
    (m, lead: string, prop: string, value: string, ws: string) => {
      if (prop.startsWith('--')) return m
      const important = /\s*!important$/i.exec(value)
      const bare = important ? value.slice(0, important.index) : value
      const name = index.get(normValue(bare))
      if (!name) return m
      used.add(name)
      return `${lead}${prop}: var(${name})${important ? important[0] : ''}${ws}`
    },
  )
}

/* ------------------------------------------------------------------ */
/* markup                                                              */
/* ------------------------------------------------------------------ */

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
])
const REACT_ATTR: Record<string, string> = {
  class: 'className',
  for: 'htmlFor',
  tabindex: 'tabIndex',
  readonly: 'readOnly',
  maxlength: 'maxLength',
  colspan: 'colSpan',
  rowspan: 'rowSpan',
  srcset: 'srcSet',
  autocomplete: 'autoComplete',
  autofocus: 'autoFocus',
  crossorigin: 'crossOrigin',
  'stroke-width': 'strokeWidth',
  'stroke-linecap': 'strokeLinecap',
  'stroke-linejoin': 'strokeLinejoin',
  'fill-rule': 'fillRule',
  'clip-rule': 'clipRule',
  viewbox: 'viewBox',
}
const BOOLEAN = new Set([
  'disabled',
  'checked',
  'selected',
  'hidden',
  'required',
  'readonly',
  'autofocus',
  'multiple',
  'open',
])

const isElement = (n: Tree.ChildNode): n is Tree.Element => 'tagName' in n
const attr = (el: Tree.Element, name: string) => el.attrs.find((a) => a.name === name)?.value

/* braces open an expression in JSX and in Astro templates alike */
const escapeText = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[{}]/g, (c) => `{'${c}'}`)
const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

function styleObject(style: string): string {
  const pairs = style
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .flatMap((d) => {
      const i = d.indexOf(':')
      if (i < 1) return []
      const prop = d.slice(0, i).trim()
      const key = prop.startsWith('--')
        ? JSON.stringify(prop)
        : prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
      return [`${key}: ${JSON.stringify(d.slice(i + 1).trim())}`]
    })
  return `{{ ${pairs.join(', ')} }}`
}

interface Walk {
  framework: FrameCodeFramework
  /** outermost instances in document order, with their props */
  instances: { componentId: string; props: Record<string, unknown> }[]
  next: number
  mapped: Map<string, { tag: string }>
  unmapped: Set<string>
  componentName: (id: string) => string
  tokenIdx: Map<string, string>
  tokens: Set<string>
  scripts: number
}

function propsOf(props: Record<string, unknown>, jsx: boolean): string {
  return Object.entries(props)
    .flatMap(([k, v]) => {
      if (typeof v === 'boolean') return v ? [k] : jsx ? [`${k}={false}`] : []
      if (typeof v === 'number') return [`${k}={${v}}`]
      if (typeof v === 'string') return [`${k}="${escapeAttr(v)}"`]
      return []
    })
    .map((s) => ` ${s}`)
    .join('')
}

function render(node: Tree.ChildNode, w: Walk, depth: number): string {
  const pad = '  '.repeat(depth)
  const jsx = w.framework === 'react'
  if (node.nodeName === '#text') {
    const text = (node as Tree.TextNode).value
    if (!text.trim()) return ''
    return `${pad}${escapeText(text.replace(/\s+/g, ' ').trim())}\n`
  }
  if (!isElement(node)) return ''
  const tag = node.tagName
  if (tag === 'script') {
    w.scripts++
    return ''
  }
  if (tag === 'style' || tag === 'template') return ''
  const instanceOf = attr(node, INSTANCE_ATTR)
  if (instanceOf) {
    const props = w.instances[w.next++]?.props ?? {}
    const mapped = w.mapped.get(instanceOf)
    if (mapped) return `${pad}<${mapped.tag}${propsOf(props, jsx)} />\n`
    w.unmapped.add(w.componentName(instanceOf))
    /* nested instances inside an unmapped one are not outermost — they stay markup */
  }
  let attrs = ''
  for (const a of node.attrs) {
    if (a.name.startsWith('data-doop-')) continue
    if (/^on[a-z]+$/i.test(a.name)) continue // inline handlers never travel
    if (jsx) {
      const name = REACT_ATTR[a.name] ?? a.name
      if (a.name === 'style') {
        attrs += ` style=${styleObject(substituteTokens(a.value, w.tokenIdx, w.tokens))}`
      } else if (BOOLEAN.has(a.name) && (a.value === '' || a.value === a.name)) attrs += ` ${name}`
      else attrs += ` ${name}="${escapeAttr(a.value)}"`
    } else {
      const value = a.name === 'style' ? substituteTokens(a.value, w.tokenIdx, w.tokens) : a.value
      attrs += a.value === '' && BOOLEAN.has(a.name) ? ` ${a.name}` : ` ${a.name}="${escapeAttr(value)}"`
    }
  }
  if (VOID.has(tag)) return `${pad}<${tag}${attrs}${jsx ? ' />' : '>'}\n`
  const kids = node.childNodes
  /* a lone short text child stays on the tag's line */
  if (kids.length === 1 && kids[0]!.nodeName === '#text') {
    const text = (kids[0] as Tree.TextNode).value.replace(/\s+/g, ' ').trim()
    if (text.length <= 80) return `${pad}<${tag}${attrs}>${escapeText(text)}</${tag}>\n`
  }
  const inner = kids.map((k) => render(k, w, depth + 1)).join('')
  if (!inner) return `${pad}<${tag}${attrs}${jsx ? ' />' : `></${tag}>`}\n`
  return `${pad}<${tag}${attrs}>\n${inner}${pad}</${tag}>\n`
}

function findTag(node: Tree.ParentNode, tag: string): Tree.Element | undefined {
  for (const kid of node.childNodes) {
    if (!isElement(kid)) continue
    if (kid.tagName === tag) return kid
    const deep = findTag(kid, tag)
    if (deep) return deep
  }
  return undefined
}

function stylesIn(node: Tree.ParentNode, out: Tree.Element[]): Tree.Element[] {
  for (const kid of node.childNodes) {
    if (!isElement(kid)) continue
    if (kid.tagName === 'style') out.push(kid)
    else stylesIn(kid, out)
  }
  return out
}

const styleText = (el: Tree.Element) =>
  el.childNodes.map((n) => (n.nodeName === '#text' ? (n as Tree.TextNode).value : '')).join('')

/* ------------------------------------------------------------------ */
/* the component                                                       */
/* ------------------------------------------------------------------ */

export function frameToCode(
  canvas: Canvas,
  frame: Frame,
  tokens: readonly DesignToken[],
  links: readonly CodeLink[],
  opts: FrameCodeOptions,
): FrameCode {
  const framework = opts.framework
  const frameLink = links.find((l) => l.targetKind === 'frame' && l.targetId === frame.id)
  const name = opts.name?.trim() ? componentNameFor(opts.name) : componentNameFor(frame.name)
  const rawPath = opts.path?.trim() || frameLink?.path || defaultFramePath(name, framework)
  const problem = codePathProblem(rawPath)
  if (problem) throw new FrameCodeError(problem)
  const path = normalizeCodePath(rawPath)
  if (!path.endsWith(EXT[framework]))
    throw new FrameCodeError(`a ${framework} component file ends in ${EXT[framework]}`)

  const defs = new Map((canvas.components ?? []).map((c) => [c.id, c]))
  const imports: FrameCode['imports'] = []
  const mapped = new Map<string, { tag: string }>()
  const taken = new Set([name])
  for (const link of links) {
    if (link.targetKind !== 'component' || !defs.has(link.targetId)) continue
    const def = defs.get(link.targetId)!
    let tag = link.exportName && link.exportName !== 'default' ? link.exportName : componentNameFor(def.name)
    for (let n = 2; taken.has(tag); n++) tag = `${componentNameFor(def.name)}${n}`
    taken.add(tag)
    mapped.set(def.id, { tag })
  }

  const doc = parse(frame.html)
  const body = findTag(doc, 'body') ?? doc
  const tokenIdx = tokenIndex(tokens)
  const walk: Walk = {
    framework,
    instances: instancesIn(frame).map((i) => ({
      componentId: i.component_id,
      props: i.props as Record<string, unknown>,
    })),
    next: 0,
    mapped,
    unmapped: new Set(),
    componentName: (id) => defs.get(id)?.name ?? id,
    tokenIdx,
    tokens: new Set(),
    scripts: 0,
  }
  const markup = body.childNodes.map((n) => render(n, walk, framework === 'react' ? 3 : 0)).join('')

  /* only the components rendered through their file are imported */
  const usedMapped = new Set(walk.instances.slice(0, walk.next).map((i) => i.componentId))
  for (const [id, { tag }] of mapped) {
    if (!usedMapped.has(id)) continue
    const link = links.find((l) => l.targetKind === 'component' && l.targetId === id)!
    imports.push({ component: defs.get(id)!.name, name: tag, from: relativeImport(path, link.path) })
  }
  const importLine = (i: (typeof imports)[number]) => {
    const link = links.find((l) => l.targetKind === 'component' && defs.get(l.targetId)?.name === i.component)!
    return !link.exportName || link.exportName === 'default'
      ? `import ${i.name} from '${i.from}'`
      : link.exportName === i.name
        ? `import { ${i.name} } from '${i.from}'`
        : `import { ${link.exportName} as ${i.name} } from '${i.from}'`
  }

  /* the frame's own CSS, and the CSS of components it inlines; never the
     managed token block — the repo declares the tokens */
  const css = stylesIn(doc, [])
    .filter((el) => attr(el, TOKEN_BLOCK_ATTR) === undefined)
    .filter((el) => {
      const owner = attr(el, CSS_ATTR)
      return owner === undefined || !usedMapped.has(owner)
    })
    .map((el) => substituteTokens(styleText(el).trim(), tokenIdx, walk.tokens))
    .filter(Boolean)
    .join('\n\n')

  const header = [
    `Generated by doop from the frame "${frame.name.replace(/\*\//g, '')}".`,
    walk.tokens.size ? `Design tokens: ${[...walk.tokens].sort().join(', ')} — declared by the repo's token CSS.` : '',
    walk.unmapped.size ? `Not mapped to code yet, inlined as markup: ${[...walk.unmapped].sort().join(', ')}.` : '',
  ].filter(Boolean)

  const files: FrameCodeFile[] = []
  if (framework === 'react') {
    const cssPath = path.replace(/\.tsx$/, '.css')
    const lines = [
      `/* ${header.join('\n   ')} */`,
      ...imports.map(importLine),
      ...(css ? [`import '${relativeImport(path, cssPath)}'`] : []),
      '',
      `export function ${name}() {`,
      '  return (',
      '    <>',
      markup.trimEnd(),
      '    </>',
      '  )',
      '}',
      '',
    ]
    files.push({ path, text: lines.join('\n') })
    if (css) files.push({ path: cssPath, text: `${css}\n` })
  } else {
    const lines = [
      '---',
      `/* ${header.join('\n   ')} */`,
      ...imports.map(importLine),
      '---',
      '',
      markup.trimEnd(),
      ...(css ? ['', '<style is:global>', css, '</style>'] : []),
      '',
    ]
    files.push({ path, text: lines.join('\n') })
  }
  return {
    framework,
    name,
    files,
    imports,
    unmapped: [...walk.unmapped].sort(),
    tokens: [...walk.tokens].sort(),
    droppedScripts: walk.scripts,
  }
}
