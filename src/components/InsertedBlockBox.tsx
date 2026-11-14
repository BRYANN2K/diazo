import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { frameWorldPoint } from '../../shared/frameRotation'
import { elementIdSelector } from '../../shared/elementId'
import { api, errorMessage } from '../lib/api'
import { adaptRequest, removeInsertedBlock } from '../lib/findInsert'
import { inspectElement, frameShows } from '../lib/frameBridge'
import { useInsertedBox } from '../lib/insertedBox'
import { currentRunnerPick } from '../lib/runnerPick'
import { useStore } from '../lib/store'
import { useT } from '../lib/i18n'
import { isResidentLimit } from './TeamAllowance'
import { Button } from './ui/button'
import { IconButton } from './ui/icon-button'
import { XIcon } from './ui/icons'
import { Textarea } from './ui/textarea'

/** What Adapt asks for when the field is left empty. */
const DEFAULT_INSTRUCTION = "adapt it to this frame's design tokens (colours, type, radius, spacing)"

/** Gap between the block's right edge and the box, in screen px. */
const GAP_PX = 12

/**
 * The box pinned beside a block ⌘F just inserted, shaped like a comment
 * thread: an instruction ("more compact, in this frame's colours"), Adapt to
 * hand it to the agent through the chat's plan flow, Undo to take the block
 * out again. Closing it keeps the block as it landed.
 */
export function InsertedBlockBox() {
  const t = useT()
  const item = useInsertedBox((s) => s.item)
  const close = useInsertedBox((s) => s.close)
  const frame = useStore((s) => (item ? s.canvas?.frames.find((f) => f.id === item.frameId) : undefined))
  const canvasId = useStore((s) => s.canvas?.id)
  const [anchor, setAnchor] = useState<{ key: string; x: number; y: number } | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const key = item ? `${item.frameId}:${item.elementId}` : ''

  /* a new block starts with an empty field */
  const [seenKey, setSeenKey] = useState(key)
  if (seenKey !== key) {
    setSeenKey(key)
    setDraft('')
  }

  /* the block's box once the frame shows the insert; the frame's corner until then */
  useEffect(() => {
    if (!item) return
    let stale = false
    const html = useStore.getState().canvas?.frames.find((f) => f.id === item.frameId)?.html ?? ''
    void frameShows(item.frameId, html)
      .then(() => inspectElement(item.frameId, elementIdSelector(item.elementId)))
      .then((info) => {
        if (stale || !info) return
        setAnchor({ key, x: info.rect.x + info.rect.width, y: info.rect.y })
      })
    fieldRef.current?.focus()
    return () => {
      stale = true
    }
  }, [item, key])

  /* the box goes when its frame or canvas does */
  useEffect(() => {
    if (item && !frame) close()
  }, [item, frame, close])

  if (!item || !frame || !canvasId) return null
  const world = document.querySelector('.stage .world')
  if (!world) return null
  const local = anchor?.key === key ? anchor : { x: frame.width, y: 0 }
  const at = frameWorldPoint(local, frame)

  async function adapt() {
    if (!item || !frame || !canvasId || sending) return
    const text = adaptRequest(item, {
      canvasId,
      frameName: frame.name,
      instruction: draft,
      fallback: DEFAULT_INSTRUCTION,
    })
    const runner = currentRunnerPick()
    setSending(true)
    try {
      await api.sendChat(canvasId, { text, ...(runner ? { runner } : {}) })
      const s = useStore.getState()
      s.setPanelTab('chat')
      s.pushNotice(t('actions.findAdaptSent'))
      close()
    } catch (err) {
      if (isResidentLimit(err)) useStore.getState().setLimitWall(true)
      else useStore.getState().pushNotice(errorMessage(err, t('actions.findAdaptFailed')))
    } finally {
      setSending(false)
    }
  }

  function undo() {
    if (item && removeInsertedBlock(item)) close()
  }

  return createPortal(
    <div
      className="absolute z-50 origin-top-left"
      style={{ left: at.x, top: at.y, transform: `scale(calc(1 / var(--zoom, 1))) translateX(${GAP_PX}px)` }}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div
        role="dialog"
        aria-label={t('actions.findAdaptLabel', { ref: item.ref })}
        className="flex w-72 flex-col gap-2 rounded-card bg-surface p-2.5 shadow-pop"
      >
        <div className="flex items-center gap-1">
          <span className="min-w-0 flex-1 truncate font-mono text-caption text-ink-soft">{item.ref}</span>
          <IconButton size="sm" aria-label={t('actions.findAdaptClose')} onClick={close}>
            <XIcon width={14} height={14} aria-hidden />
          </IconButton>
        </div>
        <Textarea
          ref={fieldRef}
          variant="well"
          rows={2}
          value={draft}
          maxLength={2000}
          placeholder={t('actions.findAdaptPlaceholder')}
          aria-label={t('actions.findAdaptPlaceholder')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              close()
            } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void adapt()
            }
          }}
          className="resize-none text-body"
        />
        <div className="flex items-center justify-end gap-1.5">
          <Button size="sm" onClick={undo} disabled={sending}>
            {t('actions.findAdaptUndo')}
          </Button>
          <Button size="sm" variant="solid" onClick={() => void adapt()} disabled={sending}>
            {t('actions.findAdapt')}
          </Button>
        </div>
      </div>
    </div>,
    world,
  )
}
