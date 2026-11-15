import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { useStore } from '../lib/store'
import { withFindPreviewScript, type FindPreviewMessage, type ItemFocus } from '../lib/findPreviewRuntime'
import { clearLivePreview, frameHtml, setLivePreview, type ItemRef } from '../lib/findSnapshot'
import { FramePreview } from './FramePreview'

/**
 * The ⌘F preview: the frame rendered live (not its top-crop image) and
 * framed on the component that matched. A library sheet holds a dozen
 * components; the one you searched for sits somewhere in the middle, so the
 * preview finds the element carrying `focus` (a library id, or the query),
 * outlines it, and zooms the frame onto it.
 *
 * The iframe loads once per frame. A focus change is a message to the
 * script inside (`findPreviewRuntime`), which moves the outline and posts
 * the new box back; only the transform here animates.
 *
 * The document plays as it does on the canvas: its animations, transitions
 * and scripts run (sandboxed, scripts only), and an `interactive` preview
 * takes the pointer, so a hover demo reacts under it. Off screen (scrolled
 * away, a hidden tab) the runtime pauses what runs and plays it on return.
 * One preview at a time: the find bar and the gallery mount one per hover.
 */

interface Box {
  x: number
  y: number
  w: number
  h: number
}

let tokens = 0

export function FindPreview({
  frameId,
  focus,
  staticNote,
  interactive = false,
  item,
  className,
}: {
  frameId: string
  focus: ItemFocus
  /** shown over a preview whose sheet runs scripts, which the copy loses */
  staticNote?: string
  /** let the pointer reach the document, so hover and pointer demos react */
  interactive?: boolean
  /** the library item shown: its frame is read through the library when the
   *  person cannot open it as a canvas (a workspace or public library) */
  item?: ItemRef
  className?: string
}) {
  const frame = useStore((s) => s.canvas?.frames.find((f) => f.id === frameId))
  const wrapRef = useRef<HTMLDivElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [doc, setDoc] = useState<{
    frameId: string
    token: string
    html: string
    width: number
    height: number
    scripted: boolean
  } | null>(null)
  const [ready, setReady] = useState<string | null>(null)
  const [box, setBox] = useState<{ token: string; focus: string; box: Box | null } | null>(null)
  const [size, setSize] = useState({ w: 444, h: 220 })
  const [visible, setVisible] = useState(true)
  /* the token of a document the pointer has played with: its markup may have
     changed, so an insert takes its copy from a fresh render instead */
  const touched = useRef<string | null>(null)
  const libraryId = item?.libraryId
  const itemId = item?.itemId

  useEffect(() => {
    let stale = false
    void frameHtml(frameId, libraryId && itemId ? { libraryId, itemId } : undefined)
      .then(({ html, width, height }) => {
        if (stale) return
        tokens += 1
        const token = `${tokens}`
        setDoc({
          frameId,
          token,
          html: withFindPreviewScript(html, token),
          width,
          height,
          scripted: /<script\b/i.test(html),
        })
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [frameId, libraryId, itemId])

  const { key, text, selector, anchor } = focus
  const current = doc?.frameId === frameId ? doc : null
  const token = current?.token ?? null

  useEffect(() => {
    if (!token) return
    const onMessage = (e: MessageEvent) => {
      const data = e.data as FindPreviewMessage | null
      if (!data || data.doopFindPreview !== token) return
      if (data.type === 'ready') setReady(token)
      else if (data.type === 'box') {
        setBox({ token, focus: data.focus ?? '', box: data.box ?? null })
        const win = iframeRef.current?.contentWindow
        if (win && touched.current !== token) {
          setLivePreview({ frameId, focus: data.focus ?? '', token, win, found: !!data.box })
        }
      }
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      clearLivePreview(token)
    }
  }, [token, frameId])

  /* the focus travels as a message once the document listens; it is sent
     again on ready, since the first one can beat the script's load */
  useEffect(() => {
    if (!token) return
    const find = { text, ...(selector ? { selector } : {}), ...(anchor ? { anchor } : {}) }
    iframeRef.current?.contentWindow?.postMessage({ doopFindPreview: token, focus: key, find }, '*')
  }, [token, key, text, selector, anchor, ready])

  /* on screen and in a visible tab, the document plays; else it is paused */
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    let onScreen = true
    const update = () => setVisible(onScreen && document.visibilityState !== 'hidden')
    const io =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver((entries) => {
            onScreen = entries.some((e) => e.isIntersecting)
            update()
          })
    io?.observe(el)
    document.addEventListener('visibilitychange', update)
    return () => {
      io?.disconnect()
      document.removeEventListener('visibilitychange', update)
    }
  }, [])

  useEffect(() => {
    if (!token || ready !== token) return
    iframeRef.current?.contentWindow?.postMessage({ doopFindPreview: token, play: visible }, '*')
  }, [token, ready, visible])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const fw = frame?.width ?? current?.width ?? 1440
  const fh = frame?.height ?? current?.height ?? 900
  /* the last box keeps the view while the next focus is looked up */
  const target = box && box.token === token ? box.box : null
  /* zoom on the matched component with a margin; otherwise fit the frame's width */
  let scale = size.w / fw
  let tx = 0
  let ty = 0
  if (target) {
    const pad = 24
    scale = Math.min((size.w - pad * 2) / target.w, (size.h - pad * 2) / target.h, 1.6)
    tx = size.w / 2 - (target.x + target.w / 2) * scale
    ty = size.h / 2 - (target.y + target.h / 2) * scale
  }

  return (
    <div
      ref={wrapRef}
      className={cn('relative h-56 flex-none overflow-hidden rounded-row bg-sub ring-1 ring-line-soft', className)}
      data-playing={visible ? 'true' : 'false'}
      onPointerEnter={() => {
        if (!interactive || !token) return
        touched.current = token
        clearLivePreview(token)
      }}
    >
      {current ? (
        <iframe
          key={current.token}
          ref={iframeRef}
          title="preview"
          sandbox="allow-scripts"
          srcDoc={current.html}
          tabIndex={-1}
          className={cn(
            'absolute top-0 left-0 origin-top-left border-0 transition-transform duration-180 ease-out motion-reduce:transition-none',
            interactive ? 'pointer-events-auto' : 'pointer-events-none',
          )}
          style={{ width: fw, height: fh, transform: `translate(${tx}px, ${ty}px) scale(${scale})` }}
        />
      ) : (
        <FramePreview frameId={frameId} empty={null} />
      )}
      {staticNote && current?.scripted && (
        <span className="pointer-events-none absolute right-1.5 bottom-1.5 rounded-tag bg-surface/90 px-1.5 py-0.5 text-micro text-ink-soft shadow-ring">
          {staticNote}
        </span>
      )}
    </div>
  )
}
