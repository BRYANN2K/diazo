/**
 * server/storyboard.ts — what a storyboard frame tells the agent animating
 * it. Designers write shorthand on storyboard panels — "MOUVEMENT /
 * TRANSITION / SON: travelling avant lent", "VOIX OFF: …" — and the Animate
 * storyboard flow turns that into work: each shot's notes and the frame's
 * animatable elements come back in the `animate_storyboard` result, and
 * `set_composition` reports the shots whose notes still have no element
 * track. Pure analysis over the frame's HTML; the stamping itself is
 * elementIds.ts's batch stamp, and persistence is actions.commitElementStamps.
 *
 * The detector is deliberately narrow: a note is a block labelled by its
 * text ("VOIX OFF: …", a shouted "SON — …") or by an explicit markup name
 * (`data-doop-notes`, a shot-notes/notes/voix-off/voice-over class or id),
 * or a shouted — caps or CSS-uppercased — or colon-ended label paired
 * with the sibling(s) holding its text. Ordinary
 * styling (`transition-all`, `motion-safe:*`, a "Sound wave" aria-label)
 * and headline copy ("Sound. Reimagined.") are never notes, and no note
 * ever promotes `body` — the notes bar is the deepest ancestor that holds
 * only notes and shot metadata.
 */

import { parse, type DefaultTreeAdapterTypes as Tree } from 'parse5'
import { ELEMENT_ID_ATTR, isElementId } from '../shared/elementId.ts'
import type { MotionTrack } from '../shared/motion.ts'
import { stampElements } from './elementIds.ts'

type Element = Tree.Element
type ParentNode = Tree.ParentNode

/* ---- what counts as a shot note ----
 * FR + EN labels designers put on storyboard panels. `son` covers a bare
 * "SON:" line; the boundary rule keeps it out of "json"/"person". */
const NOTE_WORD =
  'voix[\\s_-]*off|voice[\\s_-]*overs?|v\\.?\\s?o\\.?|mouvements?|movements?|transitions?|sons?|sound|sfx|musiques?|music|motions?|notes?|cam[ée]ras?|animations?|audios?|bruitages?|narrations?|dialogues?'

/* several labels can chain: "MOUVEMENT / TRANSITION / SON" */
const NOTE_LABELS = `(?:${NOTE_WORD})(?:\\s*[/,·+&]\\s*(?:${NOTE_WORD}))*`

/* a short qualifier may sit between the label and the separator:
   "Mouvement de caméra : travelling" */
const NOTE_QUALIFIER = '(?:\\s+\\S{1,15}){0,2}'

/* text that OPENS with a label then a colon — "MOUVEMENT : travelling",
   "Sound: low pad", "Narration : …". A period, a bare hyphen or an ellipsis
   is prose: "Sound. Reimagined.", "Motion-first design" and "Note-taking
   for teams" are headlines, not notes. */
const NOTE_COLON = new RegExp(`^\\s*${NOTE_LABELS}${NOTE_QUALIFIER}\\s*[:：]`, 'i')

/* …or a label shouted in caps followed by a spaced dash — "VOIX OFF — il
   était une fois", "SON - nappe grave". "Music - everywhere" keeps mixed
   case and stays a headline. */
const NOTE_DASH = new RegExp(`^\\s*(${NOTE_LABELS}${NOTE_QUALIFIER})\\s+[–—-]\\s+`, 'i')

/** Whether the text opens on a note label and carries more than the label. */
function startsNote(text: string): boolean {
  if (NOTE_COLON.test(text)) return true
  const dash = NOTE_DASH.exec(text)
  if (!dash) return false
  const label = dash[1]!
  return /\p{Lu}/u.test(label) && !/\p{Ll}/u.test(label)
}

/* text that is only a label — "VOIX OFF", "Notes:", "MOUVEMENT / SON" — the
   note is then the label's sibling(s), never its parent */
const NOTE_ONLY = new RegExp(`^\\s*${NOTE_LABELS}\\s*:?\\s*$`, 'i')

/* a bare label can never sit in a link or a button — "Notes" a nav item
   or a CTA is design copy, not a storyboard label — and a heading only
   counts when it shouts: a mixed-case "Notes" card title stays design */
const NOT_LABEL_TAGS = new Set(['a', 'button'])
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

/* a notes panel labelled by markup: a bare data-doop-notes marker, or a
   class/id token equal to or prefixed shot-notes / notes / voix-off /
   voice-over. Nothing else counts — transition-all, motion-safe:*,
   motion-hero, a "Sound wave" aria-label and data-name="Notes app" are
   styling or content, not notes. */
const NOTE_PANEL_NAMES = ['shot-notes', 'notes', 'voix-off', 'voice-over'] as const

/* the title row of a notes bar — "01 · L'accroche 00–04 s": a shot number,
   a timecode or a duration. Anything else is design content and keeps the
   bar from being all-notes. */
const SHOT_META =
  /^\s*(?:\d{1,3}\s*[·•.):—–-]|(?:shot|s[ée]quence|sc[èe]ne|plan|take|seq)\s*[.n°]*\s*\d+|\d{1,2}:\d{2}(?::\d{2})?|\d{1,3}\s*[—–-]\s*\d{1,3}\s*s\b)/i

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

/* a note's text after a bare label: one text-leaf sibling of a plain
   shape — a wrapper, a heading or an image is design, not the note */
const NOTE_VALUE_TAGS = new Set(['p', 'div', 'span', 'dd', 'li', 'blockquote', 'q', 'small'])

/* what an agent can usefully keyframe, in reading order of usefulness:
   headlines and text, imagery, then the structural layers parallax moves
   need, then named divs */
const TARGET_PRIMARY = new Set([
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
])

const TARGET_SECONDARY = new Set([
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
/** check rounds the coverage report grants before telling the agent to stop */
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

/* what the agent reads: one space between blocks, so "SON" and "Travelling"
   never fuse into "SONTravelling" */
function textOf(node: ParentNode): string {
  let text = ''
  for (const child of node.childNodes) {
    if ('value' in child && child.nodeName === '#text') text += child.value
    else if ('childNodes' in child) text += ` ${textOf(child)}`
  }
  return text.replace(/\s+/g, ' ').trim()
}

/* the text outside the notes bar — a wrapper's label describes the design,
   not the notes it happens to contain */
function textOutside(node: ParentNode, skip: ReadonlySet<Element>): string {
  let text = ''
  for (const child of node.childNodes) {
    if ('value' in child && child.nodeName === '#text') text += child.value
    else if (isElement(child) && !skip.has(child)) text += ` ${textOutside(child, skip)}`
  }
  return text.replace(/\s+/g, ' ').trim()
}

function nextElementSibling(el: Element): Element | undefined {
  const sibs = el.parentNode?.childNodes ?? []
  for (let i = sibs.indexOf(el) + 1; i < sibs.length; i++) {
    const s = sibs[i]!
    if (isElement(s)) return s
    if (s.nodeName === '#comment') continue
    if (s.nodeName === '#text' && 'value' in s && s.value.trim() === '') continue
    return undefined
  }
  return undefined
}

function concealed(el: Element): boolean {
  return (
    attr(el, 'hidden') !== undefined ||
    attr(el, 'aria-hidden') === 'true' ||
    /display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)/i.test(attr(el, 'style') ?? '')
  )
}

/* the element or an ancestor is hidden/display:none — not a target */
function isHidden(el: Element): boolean {
  for (let node: Tree.ParentNode | null | undefined = el; node && isElement(node); node = node.parentNode) {
    if (concealed(node)) return true
  }
  return false
}

function labelledByAttrs(el: Element): boolean {
  /* a bare data-doop-notes marker needs no value to name the panel */
  if (attr(el, 'data-doop-notes') !== undefined) return true
  for (const name of ['id', 'class'] as const) {
    const value = attr(el, name)
    if (!value) continue
    for (const raw of value.split(/\s+/)) {
      const token = raw.toLowerCase().replace(/_/g, '-')
      if (NOTE_PANEL_NAMES.some((n) => token === n || token.startsWith(`${n}-`))) return true
    }
  }
  return false
}

/* ---- the note blocks of one frame ---- */

interface NoteGroup {
  /** the elements carrying the note — one labelled block, or a label and
   *  the sibling(s) holding its text */
  elements: Element[]
  text: string
  /** the element whose id hides the note — its own block, or the first of
   *  a group nothing wraps cleanly */
  cover: Element
  /** the topmost ancestor holding only notes and shot meta — the notes bar */
  panel?: Element
}

/* an `uppercase` class token or an inline text-transform shouts the label
   as surely as caps — designers often write "voix off" and let CSS shout */
function cssShouted(el: Element): boolean {
  if (attr(el, 'class')?.split(/\s+/).includes('uppercase')) return true
  return /text-transform\s*:\s*uppercase\b/i.test(attr(el, 'style') ?? '')
}

/* a lone label word pairs with the sibling carrying its text only when it
   marks itself as a label — shouted like the dash form, in caps or by CSS
   ("VOIX OFF", class="uppercase"), or with a trailing colon ("Notes:") —
   in a plain element or a heading that shouts: a feature grid titled
   Animations / Notes / Sound is product copy, not shot notes */
function bareLabel(el: Element): boolean {
  const text = textOf(el).trim()
  if (!NOTE_ONLY.test(text)) return false
  const shouted = (/\p{Lu}/u.test(text) && !/\p{Ll}/u.test(text)) || cssShouted(el)
  if (!/[:：]$/.test(text) && !shouted) return false
  for (let node: ParentNode | null | undefined = el; node && isElement(node); node = node.parentNode) {
    const tag = node.tagName.toLowerCase()
    if (NOT_LABEL_TAGS.has(tag) || (HEADING_TAGS.has(tag) && !shouted)) return false
    if (SKIP_TAGS.has(tag)) break
  }
  return true
}

/* a leaf sibling that can hold a note's text after a bare label: plain
   text in a plain tag, itself no label, no meta row and no deeper markup */
function noteValue(el: Element): boolean {
  const tag = el.tagName.toLowerCase()
  if (SKIP_TAGS.has(tag) || !NOTE_VALUE_TAGS.has(tag) || concealed(el)) return false
  if (elementChildren(el).length > 0) return false
  const text = textOf(el)
  return text !== '' && !NOTE_ONLY.test(text) && !startsNote(text) && !SHOT_META.test(text)
}

/* every child is a label, a meta row, a value candidate or hidden — the
   label's siblings are all note text, not design it sits inside */
function looksNoteish(el: Element): boolean {
  if (concealed(el)) return true
  const text = textOf(el)
  return text === '' || NOTE_ONLY.test(text) || startsNote(text) || SHOT_META.test(text) || noteValue(el)
}

function containsNote(el: Element, noteSubtree: ReadonlySet<Element>): boolean {
  if (noteSubtree.has(el)) return true
  return elementChildren(el).some((child) => containsNote(child, noteSubtree))
}

/* every descendant of `el` is note content, hidden, or a shot-meta row —
   then `el` is part of the notes bar, never a design element to animate */
function notesOnly(el: Element, noteSubtree: ReadonlySet<Element>): boolean {
  if (noteSubtree.has(el) || concealed(el)) return true
  if (!elementChildren(el).some((child) => containsNote(child, noteSubtree))) {
    const text = textOf(el)
    return text === '' || SHOT_META.test(text)
  }
  for (const child of el.childNodes) {
    if ('value' in child && child.nodeName === '#text') {
      const text = child.value.replace(/\s+/g, ' ').trim()
      if (text !== '' && !SHOT_META.test(text)) return false
    } else if (isElement(child) && !notesOnly(child, noteSubtree)) {
      return false
    }
  }
  return true
}

/* the nearest and the topmost ancestor of `el` that hold only notes and
   shot metadata. The walk never promotes html/body and stops where real
   content starts — a label alone can never make the whole frame a note. */
function noteBlock(el: Element, noteSubtree: ReadonlySet<Element>): { cover?: Element; panel?: Element } {
  let cover: Element | undefined
  let panel: Element | undefined
  for (let node = el.parentNode; node && isElement(node); node = node.parentNode) {
    if (SKIP_TAGS.has(node.tagName.toLowerCase())) break
    if (!notesOnly(node, noteSubtree)) break
    cover ??= node
    panel = node
  }
  return { cover, panel }
}

interface ParsedShot {
  groups: NoteGroup[]
  /** every element inside a note or the notes bar — excluded from targets */
  noteSubtree: Set<Element>
  /** the distinct notes bars the groups share */
  panels: Set<Element>
}

function parseShot(doc: Tree.Document): ParsedShot {
  const groups: NoteGroup[] = []
  const noteSubtree = new Set<Element>()
  const claim = (elements: readonly Element[]) => {
    for (const el of elements) {
      noteSubtree.add(el)
      for (const d of walk(el)) noteSubtree.add(d)
    }
  }

  /* panels labelled by markup, outermost first */
  for (const el of walk(doc)) {
    if (noteSubtree.has(el) || SKIP_TAGS.has(el.tagName.toLowerCase()) || !labelledByAttrs(el)) continue
    groups.push({ elements: [el], text: textOf(el), cover: el })
    claim([el])
  }
  /* elements whose text opens on a label and carries more than it — the
     deepest such element, so <p><b>VOIX OFF:</b> text</p> gives the p */
  for (const el of walk(doc)) {
    if (noteSubtree.has(el) || SKIP_TAGS.has(el.tagName.toLowerCase())) continue
    const text = textOf(el)
    if (!startsNote(text) || NOTE_ONLY.test(text)) continue
    if (
      elementChildren(el).some(
        (child) => !noteSubtree.has(child) && startsNote(textOf(child)) && !NOTE_ONLY.test(textOf(child)),
      )
    )
      continue
    groups.push({ elements: [el], text, cover: el })
    claim([el])
  }
  /* a bare label pairs with the sibling(s) holding its text — all of them
     inside a notes-only parent, only the next one in mixed content, and
     never the parent itself */
  for (const el of walk(doc)) {
    if (noteSubtree.has(el) || SKIP_TAGS.has(el.tagName.toLowerCase()) || concealed(el)) continue
    if (!bareLabel(el)) continue
    const parent = el.parentNode
    const clean = parent !== null && isElement(parent) && elementChildren(parent).every(looksNoteish)
    const elements = [el]
    for (let s = nextElementSibling(el); s; s = nextElementSibling(s)) {
      if (noteSubtree.has(s) || !noteValue(s)) break
      elements.push(s)
      if (!clean) break
    }
    if (elements.length === 1) continue
    groups.push({ elements, text: elements.map(textOf).join(' '), cover: el })
    claim(elements)
  }

  /* the bars: ancestors holding only notes and shot metadata, with the
     title row included — never html/body */
  const panels = new Set<Element>()
  for (const group of groups) {
    const { cover, panel } = noteBlock(group.elements[0]!, noteSubtree)
    if (cover) group.cover = cover
    if (panel) {
      group.panel = panel
      panels.add(panel)
      noteSubtree.add(panel)
      for (const el of walk(panel)) noteSubtree.add(el)
    }
  }
  return { groups, noteSubtree, panels }
}

function groupNotes(parsed: ParsedShot): { text: string; cover: Element; panel?: Element }[] {
  const out: { text: string; cover: Element; panel?: Element }[] = []
  const seen = new Set<string>()
  for (const group of parsed.groups) {
    const text = group.text.slice(0, SHOT_NOTE_MAX_CHARS)
    if (text && !seen.has(text)) {
      seen.add(text)
      out.push({ text, cover: group.cover, panel: group.panel })
    }
    if (out.length >= SHOT_MAX_NOTES) break
  }
  return out
}

export interface ShotNote {
  /** the data-doop-id hiding this note — its own block, or the shared notes bar */
  id?: string
  text: string
}

export interface ShotTarget {
  id: string
  tag: string
  /** what the element is: a text excerpt, an alt, a src name, a class */
  label: string
}

export interface ShotInfo {
  notes: string[]
  /** ids that carry note content — a track on one hides notes, it does not animate */
  noteIds: ReadonlySet<string>
  /** every data-doop-id the frame carries — a track's elementId must be one to count */
  elementIds: ReadonlySet<string>
}

export interface ShotAnalysis {
  /** the frame's HTML with the ids stamped in; unchanged when nothing needed one */
  html: string
  /** the fresh ids written this pass — commitElementStamps tracks these */
  stampedIds: string[]
  notes: ShotNote[]
  /** the whole notes bar's data-doop-id when the shot's notes share one —
   *  hiding it keeps the bar and its title row out of the film */
  panelId?: string
  /** ids that carry note content — a track on one hides notes, it does not animate */
  noteIds: ReadonlySet<string>
  /** every data-doop-id the stamped frame carries */
  elementIds: ReadonlySet<string>
  targets: ShotTarget[]
}

function collectIds(
  doc: Tree.Document,
  noteSubtree: ReadonlySet<Element>,
  stamped: ReadonlyMap<Element, string>,
): { noteIds: Set<string>; elementIds: Set<string> } {
  const noteIds = new Set<string>()
  const elementIds = new Set<string>()
  for (const el of walk(doc)) {
    const id = stamped.get(el) ?? attr(el, ELEMENT_ID_ATTR)
    if (!id || !isElementId(id)) continue
    elementIds.add(id)
    if (noteSubtree.has(el)) noteIds.add(id)
  }
  return { noteIds, elementIds }
}

/**
 * The note texts a frame carries, deduped and in document order — the
 * cheap read the coverage check runs on every set_composition.
 */
export function shotNotesIn(html: string): string[] {
  return groupNotes(parseShot(parse(html))).map((note) => note.text)
}

/** The notes-plus-ids read of a frame that must not be stamped: what the
 *  set_composition check uses to tell real element animation from a hidden
 *  notes layer or an id that is not there. */
export function inspectShotHtml(html: string): ShotInfo {
  const doc = parse(html)
  const parsed = parseShot(doc)
  const { noteIds, elementIds } = collectIds(doc, parsed.noteSubtree, new Map())
  return { notes: groupNotes(parsed).map((note) => note.text), noteIds, elementIds }
}

function targetLabel(el: Element, noteSubtree: ReadonlySet<Element>): string {
  const text = textOutside(el, noteSubtree)
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
 * Read one shot's frame: its note blocks, the notes bar they may share, and
 * the elements worth animating — every reported element addressable by
 * `data-doop-id`, fresh stamps going in by source offset the way the
 * comments flow writes them.
 */
export function analyzeShotHtml(html: string): ShotAnalysis {
  const doc = parse(html, { sourceCodeLocationInfo: true })
  const parsed = parseShot(doc)
  const notes = groupNotes(parsed)
  const noteEls = new Set<Element>()
  for (const group of parsed.groups) for (const el of group.elements) noteEls.add(el)
  for (const note of notes) noteEls.add(note.cover)
  for (const panel of parsed.panels) noteEls.add(panel)

  /* targets: headlines, text and imagery first, structural layers and named
     divs last — the cap keeps a deep headline from falling off the list */
  const candidates: { el: Element; tag: string; label: string; rank: number; order: number }[] = []
  let order = 0
  for (const el of walk(doc)) {
    const tag = el.tagName.toLowerCase()
    if (SKIP_TAGS.has(tag) || isHidden(el) || parsed.noteSubtree.has(el)) continue
    const primary = TARGET_PRIMARY.has(tag)
    const secondary = TARGET_SECONDARY.has(tag)
    /* a named div is a layer — the parallax moves notes ask for need one */
    const namedDiv = tag === 'div' && (attr(el, 'id') ?? attr(el, 'class')) !== undefined
    if (!primary && !secondary && !namedDiv) continue
    candidates.push({
      el,
      tag,
      label: targetLabel(el, parsed.noteSubtree),
      rank: primary ? 0 : secondary ? 1 : 2,
      order: order++,
    })
  }
  const picked = candidates.sort((a, b) => a.rank - b.rank || a.order - b.order).slice(0, SHOT_MAX_TARGETS)

  /* stamp the note blocks (covers and the shared bar are in noteEls) and
     the targets in one pass — an element with no start-tag source can
     take no id, and a repeat would stamp the same offsets twice */
  const stamp = [...noteEls, ...picked.map((t) => t.el)]
  const { html: stampedHtml, ids, freshIds } = stampElements(html, stamp)
  const { noteIds, elementIds } = collectIds(doc, parsed.noteSubtree, ids)

  const panels = [...parsed.panels]
  return {
    html: stampedHtml,
    stampedIds: freshIds,
    notes: notes.flatMap((note) => {
      const id = ids.get(note.cover)
      return id ? [{ text: note.text, id }] : [{ text: note.text }]
    }),
    panelId: panels.length === 1 ? ids.get(panels[0]!) : undefined,
    noteIds,
    elementIds,
    targets: picked.flatMap((t) => {
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
  /** consecutive check rounds that saw no progress, out of STORYBOARD_MAX_PASSES */
  pass: number
  maxPasses: number
  message: string
}

/** A noted shot counts as animated only by an element track that has
 *  keyframes on a real, non-notes element of its frame — an opacity-0 track
 *  on the notes block hides the notes, it does not animate the shot, and an
 *  elementId that is not in the frame animates nothing. */
export function pendingNotedShots(
  tracks: readonly Pick<MotionTrack, 'kind' | 'frameId' | 'elementId' | 'muted' | 'keyframes'>[],
  noted: ReadonlyMap<string, ShotInfo>,
): PendingShot[] {
  const animated = new Set<string>()
  for (const track of tracks) {
    if (track.kind !== 'element' || track.muted) continue
    if (!track.frameId || !track.elementId || (track.keyframes?.length ?? 0) === 0) continue
    const info = noted.get(track.frameId)
    if (info && info.elementIds.has(track.elementId) && !info.noteIds.has(track.elementId)) {
      animated.add(track.frameId)
    }
  }
  const pending: PendingShot[] = []
  for (const [frameId, info] of noted) {
    if (!animated.has(frameId)) pending.push({ frameId, notes: info.notes })
  }
  return pending
}

/**
 * Compare a film's noted shots against the composition's element tracks.
 * `pass` is how many check rounds in a row reported the same pending set —
 * after `maxPasses` the message tells the agent to stop fixing and say so.
 */
export function storyboardCoverage(
  tracks: readonly Pick<MotionTrack, 'kind' | 'frameId' | 'elementId' | 'muted' | 'keyframes'>[],
  noted: ReadonlyMap<string, ShotInfo>,
  pass: number,
  maxPasses = STORYBOARD_MAX_PASSES,
): StoryboardCoverage {
  const pending = pendingNotedShots(tracks, noted)
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
