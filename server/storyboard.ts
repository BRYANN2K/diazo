/**
 * server/storyboard.ts — what a storyboard frame tells the agent animating
 * it. Designers write shorthand on storyboard panels — "MOUVEMENT /
 * TRANSITION / SON: travelling avant lent", "VOIX OFF: …" — and the Animate
 * storyboard flow turns that into work: each shot's notes and the frame's
 * animatable elements come back in the `animate_storyboard` result, and
 * `set_composition` reports the shots whose notes still have no element
 * track. Pure analysis over the frame's HTML; the stamping itself is
 * elementIds.ts's batch stamp, and persistence is actions.commitElementStamps.
 */

import { parse, type DefaultTreeAdapterTypes as Tree } from 'parse5'
import type { Composition } from '../shared/motion.ts'
import { stampElements } from './elementIds.ts'

type Element = Tree.Element
type ParentNode = Tree.ParentNode

/* ---- what counts as a shot note ----
 * FR + EN labels designers put on storyboard panels. `son` covers a bare
 * "SON:" line; the boundary rule keeps it out of "json"/"person". */
const NOTE_WORD =
  'voix[\\s_-]*off|voice[\\s_-]*overs?|v\\.?\\s?o\\.?|mouvements?|movements?|transitions?|sons?|sound|sfx|musiques?|music|motions?|notes?'

/* text that OPENS with a label — "MOUVEMENT:", "VOIX OFF —", or a combined
   "MOUVEMENT / TRANSITION / SON:" */
const NOTE_START = new RegExp(`^\\s*(?:${NOTE_WORD})(?:\\s*[/,·+&]\\s*(?:${NOTE_WORD}))*\\s*[:：.\\-–—…]`, 'i')

/* text that is only a label — "<dt>VOIX OFF</dt><dd>…" style; the note is
   then the enclosing block's text */
const NOTE_ONLY = new RegExp(`^\\s*(?:${NOTE_WORD})(?:\\s*[/,·+&]\\s*(?:${NOTE_WORD}))*\\s*:?\\s*$`, 'i')

/* a panel labelled by markup: class="shot-notes", id="voix-off",
   aria-label="Voice-over" */
const NOTE_ATTR = new RegExp(`(?:^|[\\s_\\-.:/])(${NOTE_WORD})(?=[\\s_\\-.:/]|$)`, 'i')

const NOTE_ATTRS = ['id', 'class', 'aria-label', 'data-label', 'data-name', 'data-doop-notes'] as const

/* markup that is never a note and never a target */
const SKIP_TAGS = new Set([
  'html',
  'head',
  'body',
  'script',
  'style',
  'link',
  'meta',
  'title',
  'base',
  'noscript',
  'template',
  'br',
  'hr',
  'wbr',
])

/* what an agent can usefully keyframe: headlines and text blocks, imagery,
   and the structural layers parallax moves need */
const TARGET_TAGS = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'blockquote',
  'li',
  'figcaption',
  'img',
  'picture',
  'video',
  'svg',
  'canvas',
  'figure',
  'button',
  'a',
  'nav',
  'header',
  'footer',
  'main',
  'section',
  'article',
  'aside',
  'form',
  'fieldset',
  'input',
  'select',
  'textarea',
  'label',
  'table',
  'ul',
  'ol',
  'dl',
])

export const SHOT_NOTE_MAX_CHARS = 480
export const SHOT_MAX_NOTES = 6
export const SHOT_MAX_TARGETS = 24
/** fix passes the coverage report asks for before telling the agent to stop */
export const STORYBOARD_MAX_PASSES = 2

function isElement(node: unknown): node is Element {
  return typeof node === 'object' && node !== null && 'tagName' in node
}

function elementChildren(node: ParentNode): Element[] {
  return node.childNodes.filter(isElement)
}

function* walk(node: ParentNode): Generator<Element> {
  const stack: Element[] = elementChildren(node).reverse()
  for (let next = stack.pop(); next; next = stack.pop()) {
    yield next
    for (const child of elementChildren(next).reverse()) stack.push(child)
  }
}

function attr(el: Element, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value
}

function textOf(node: ParentNode): string {
  let text = ''
  for (const child of node.childNodes) {
    if ('value' in child && child.nodeName === '#text') text += child.value
    else if ('childNodes' in child) text += textOf(child)
  }
  return text.replace(/\s+/g, ' ').trim()
}

function labelledByAttrs(el: Element): boolean {
  /* a bare data-doop-notes marker needs no value to name the panel */
  if (attr(el, 'data-doop-notes') !== undefined) return true
  return NOTE_ATTRS.some((name) => {
    const value = attr(el, name)
    return value !== undefined && NOTE_ATTR.test(value)
  })
}

/** The elements that open with a notes label AND carry more than the label
 *  itself, with no deeper element doing the same — the p in
 *  `<div><p><b>VOIX OFF:</b> text</p></div>` wins over both div and b. */
function contentNotes(doc: Tree.Document): Element[] {
  const out: Element[] = []
  for (const el of walk(doc)) {
    if (SKIP_TAGS.has(el.tagName.toLowerCase())) continue
    const text = textOf(el)
    if (!NOTE_START.test(text) || NOTE_ONLY.test(text)) continue
    if (elementChildren(el).some((child) => NOTE_START.test(textOf(child)) && !NOTE_ONLY.test(textOf(child)))) continue
    out.push(el)
  }
  return out
}

function isInside(el: Element, root: Element): boolean {
  for (let node = el.parentNode; node && isElement(node); node = node.parentNode) {
    if (node === root) return true
  }
  return false
}

/**
 * The note blocks of one frame's HTML: panels labelled by markup first
 * (class/id/aria-label naming notes, voix off, son…), then elements whose
 * text opens with a label, then label-only elements promoted to the block
 * that holds their content. A root never contains another root.
 */
function noteRoots(doc: Tree.Document): Element[] {
  const roots: Element[] = []
  const panels = [...walk(doc)].filter((el) => !SKIP_TAGS.has(el.tagName.toLowerCase()) && labelledByAttrs(el))
  for (const el of panels) {
    if (panels.some((other) => other !== el && isInside(el, other))) continue
    roots.push(el)
  }
  for (const el of contentNotes(doc)) {
    if (roots.some((root) => isInside(el, root) || root === el)) continue
    roots.push(el)
  }
  /* a bare label ("VOIX OFF" alone in a dt or a heading) borrows the first
     ancestor with more to say; one that lands inside a root already found
     adds nothing */
  for (const el of walk(doc)) {
    if (SKIP_TAGS.has(el.tagName.toLowerCase())) continue
    const text = textOf(el)
    if (!NOTE_ONLY.test(text)) continue
    if (roots.some((root) => root === el || isInside(el, root))) continue
    for (let node = el.parentNode; node && isElement(node); node = node.parentNode) {
      const fuller = textOf(node)
      if (fuller !== text && fuller.length > text.length) {
        if (!roots.some((root) => root === node || isInside(node, root))) roots.push(node)
        break
      }
    }
  }
  return roots
}

/** The note texts a frame carries, deduped and in document order — the
 *  cheap read the coverage check runs on every set_composition. */
export function shotNotesIn(html: string): string[] {
  const doc = parse(html)
  const out: string[] = []
  for (const root of noteRoots(doc)) {
    const text = textOf(root).slice(0, SHOT_NOTE_MAX_CHARS)
    if (text && !out.includes(text)) out.push(text)
    if (out.length >= SHOT_MAX_NOTES) break
  }
  return out
}

export interface ShotNote {
  /** the notes block's data-doop-id — the layer to hide from the render */
  id?: string
  text: string
}

export interface ShotTarget {
  id: string
  tag: string
  /** what the element is: a text excerpt, an alt, a src name, a class */
  label: string
}

export interface ShotAnalysis {
  /** the frame's HTML with the ids stamped in; unchanged when nothing needed one */
  html: string
  /** the fresh ids written this pass — commitElementStamps tracks these */
  stampedIds: string[]
  notes: ShotNote[]
  targets: ShotTarget[]
}

function hidden(el: Element): boolean {
  return attr(el, 'hidden') !== undefined || attr(el, 'aria-hidden') === 'true'
}

function targetLabel(el: Element): string {
  const text = textOf(el)
  if (text) return text.slice(0, 60)
  for (const name of ['alt', 'aria-label', 'title', 'placeholder'] as const) {
    const value = attr(el, name)?.trim()
    if (value) return value.slice(0, 60)
  }
  const src = attr(el, 'src') ?? attr(el, 'href')
  if (src) {
    const leaf = src.split(/[?#]/)[0]?.split('/').pop()
    if (leaf) return leaf.slice(0, 60)
  }
  const cls = attr(el, 'class')?.trim().split(/\s+/)[0]
  return cls ? `.${cls}`.slice(0, 60) : `<${el.tagName}>`
}

/**
 * Read one shot's frame: its note blocks and the elements worth animating,
 * with every reported element addressable by `data-doop-id` — fresh stamps
 * go in by source offset, same as the comments flow writes them.
 */
export function analyzeShotHtml(html: string): ShotAnalysis {
  const doc = parse(html, { sourceCodeLocationInfo: true })
  const roots = noteRoots(doc)
  const notes: ShotNote[] = []
  const noteEls: Element[] = []
  const seen = new Set<string>()
  for (const root of roots) {
    const text = textOf(root).slice(0, SHOT_NOTE_MAX_CHARS)
    if (text && !seen.has(text)) {
      seen.add(text)
      notes.push({ text })
      noteEls.push(root)
    }
    if (notes.length >= SHOT_MAX_NOTES) break
  }

  const targets: { el: Element; tag: string; label: string }[] = []
  for (const el of walk(doc)) {
    if (targets.length >= SHOT_MAX_TARGETS) break
    const tag = el.tagName.toLowerCase()
    if (SKIP_TAGS.has(tag) || hidden(el)) continue
    /* a named div is a layer — the parallax moves notes ask for need one */
    const target = TARGET_TAGS.has(tag) || (tag === 'div' && (attr(el, 'id') ?? attr(el, 'class')) !== undefined)
    if (!target) continue
    if (roots.some((root) => el === root || isInside(el, root))) continue
    targets.push({ el, tag, label: targetLabel(el) })
  }

  /* stamp the notes blocks and the targets in one pass — an element with
     no start-tag source can take no id and is dropped from the targets */
  const stamp = [...noteEls, ...targets.map((t) => t.el)]
  const { html: stampedHtml, ids, freshIds } = stampElements(html, stamp)
  notes.forEach((note, i) => {
    const id = ids.get(noteEls[i]!)
    if (id) note.id = id
  })
  return {
    html: stampedHtml,
    stampedIds: freshIds,
    notes,
    targets: targets.flatMap((t) => {
      const id = ids.get(t.el)
      return id ? [{ id, tag: t.tag, label: t.label }] : []
    }),
  }
}

/* ---- the coverage check: shots whose notes still have no element track ---- */

export interface PendingShot {
  frameId: string
  notes: string[]
}

export interface StoryboardCoverage {
  /** shots carrying notes */
  noted: number
  /** of those, the ones an element track already animates */
  animated: number
  pending: PendingShot[]
  /** which fix pass this report is, out of STORYBOARD_MAX_PASSES */
  pass: number
  maxPasses: number
  message: string
}

/**
 * Compare a page's noted shots against the composition's element tracks.
 * `pass` is how many times this page has already been reported missing —
 * after `maxPasses` the message tells the agent to stop fixing and say so.
 */
export function storyboardCoverage(
  tracks: readonly Pick<Composition['tracks'][number], 'kind' | 'frameId' | 'keyframes'>[],
  noted: ReadonlyMap<string, string[]>,
  pass: number,
  maxPasses = STORYBOARD_MAX_PASSES,
): StoryboardCoverage {
  const animated = new Set(
    tracks.filter((t) => t.kind === 'element' && t.frameId && (t.keyframes?.length ?? 0) > 0).map((t) => t.frameId!),
  )
  const pending: PendingShot[] = []
  for (const [frameId, notes] of noted) {
    if (!animated.has(frameId)) pending.push({ frameId, notes })
  }
  const message =
    pending.length === 0
      ? noted.size > 0
        ? `Every noted shot (${noted.size}) has an element track — the storyboard is animated.`
        : 'No shot on this page carries notes.'
      : pass >= maxPasses
        ? `${pending.length} noted shot(s) still have no element track after ${maxPasses} passes — finish and name them in your final message: ${pending.map((p) => p.frameId).join(', ')}.`
        : `${pending.length} noted shot(s) have no element track yet — animate their elements per their notes before finishing (fix pass ${pass + 1} of ${maxPasses}): ${pending.map((p) => p.frameId).join(', ')}.`
  return { noted: noted.size, animated: noted.size - pending.length, pending, pass, maxPasses, message }
}
