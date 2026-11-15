/**
 * Getting a library item's snapshot for ⌘F's insert. The preview iframe
 * already rendered the item (React sheets included), so when it shows the
 * one being inserted it is asked directly; otherwise (a click faster than
 * the hover intent, a keyboard insert) a hidden iframe renders the frame,
 * finds the item and answers the same way.
 */
import { api } from './api'
import { useStore } from './store'
import {
  withFindPreviewScript,
  type FindPreviewMessage,
  type ItemFocus,
  type LibrarySnapshot,
} from './findPreviewRuntime'

interface Loaded {
  html: string
  width: number
  height: number
}

const htmlCache = new Map<string, Promise<Loaded>>()

/** The library item a frame is read for, when the frame itself may not be:
 *  a workspace or public library is read through its item routes. */
export interface ItemRef {
  libraryId: string
  itemId: string
}

/** A frame's HTML and size: from the open canvas, else fetched once; a
 *  library item's frame the person cannot open as a canvas is read through
 *  the library (`/api/libraries/:id/items/:itemId/html`), so the preview
 *  still runs live instead of settling on the frame's still image. */
export function frameHtml(frameId: string, via?: ItemRef): Promise<Loaded> {
  const local = useStore.getState().canvas?.frames.find((f) => f.id === frameId)
  if (local?.html) return Promise.resolve({ html: local.html, width: local.width, height: local.height })
  let p = htmlCache.get(frameId)
  if (!p) {
    const asFrame = () => api.frame(frameId).then((f) => ({ html: f.html ?? '', width: f.width, height: f.height }))
    const asItem = (ref: ItemRef) =>
      api.libraryItemHtml(ref.libraryId, ref.itemId).then((f) => ({ html: f.html, width: f.width, height: f.height }))
    p = via ? asFrame().catch(() => asItem(via)) : asFrame()
    p.catch(() => htmlCache.delete(frameId))
    htmlCache.set(frameId, p)
  }
  return p
}

/** The preview on screen, as the last box it reported. */
export interface LivePreview {
  frameId: string
  focus: string
  token: string
  win: Window
  found: boolean
}

let live: LivePreview | null = null

export function setLivePreview(preview: LivePreview | null) {
  live = preview
}

export function clearLivePreview(token: string) {
  if (live?.token === token) live = null
}

const SNAPSHOT_TIMEOUT_MS = 3000
const LOAD_TIMEOUT_MS = 10_000
/* the runtime retries a focus it cannot see yet at 500 and 1500 ms */
const FIND_WAIT_MS = 1700

function waitFor(
  token: string,
  test: (m: FindPreviewMessage) => boolean,
  ms: number,
): Promise<FindPreviewMessage | null> {
  return new Promise((resolve) => {
    const done = (m: FindPreviewMessage | null) => {
      window.clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      resolve(m)
    }
    const onMessage = (e: MessageEvent) => {
      const m = e.data as FindPreviewMessage | null
      if (m?.doopFindPreview === token && test(m)) done(m)
    }
    const timer = window.setTimeout(() => done(null), ms)
    window.addEventListener('message', onMessage)
  })
}

async function ask(win: Window, token: string): Promise<LibrarySnapshot | null> {
  const request = Math.random().toString(36).slice(2)
  const reply = waitFor(token, (m) => m.type === 'snapshot' && m.request === request, SNAPSHOT_TIMEOUT_MS)
  win.postMessage({ doopFindPreview: token, snapshot: request }, '*')
  return (await reply)?.snapshot ?? null
}

async function offscreen(frameId: string, focus: ItemFocus, via?: ItemRef): Promise<LibrarySnapshot | null> {
  const { html, width, height } = await frameHtml(frameId, via)
  const token = `snap-${Math.random().toString(36).slice(2)}`
  const iframe = document.createElement('iframe')
  iframe.setAttribute('sandbox', 'allow-scripts')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.tabIndex = -1
  Object.assign(iframe.style, {
    position: 'fixed',
    left: '-100000px',
    top: '0',
    width: `${width}px`,
    height: `${height}px`,
    opacity: '0',
    pointerEvents: 'none',
    border: '0',
  })
  const ready = waitFor(token, (m) => m.type === 'ready', LOAD_TIMEOUT_MS)
  iframe.srcdoc = withFindPreviewScript(html, token)
  document.body.append(iframe)
  try {
    if (!(await ready) || !iframe.contentWindow) return null
    const found = waitFor(token, (m) => m.type === 'box' && !!m.box, FIND_WAIT_MS)
    iframe.contentWindow.postMessage({ doopFindPreview: token, focus: focus.key, find: focus }, '*')
    await found
    return await ask(iframe.contentWindow, token)
  } finally {
    iframe.remove()
  }
}

/** The item `focus` names in the frame, as rendered. The preview on
 *  screen answers only while nobody has played with it: a hovered demo may
 *  have changed its own markup, and the copy is taken from a fresh render. */
export function snapshotLibraryItem(frameId: string, focus: ItemFocus, via?: ItemRef): Promise<LibrarySnapshot | null> {
  if (live && live.frameId === frameId && live.focus === focus.key && live.found) return ask(live.win, live.token)
  return offscreen(frameId, focus, via)
}
