import { useEffect, useState } from 'react'
import type { CanvasMeta, Frame } from '../../../shared/types'
import type { LibraryItemSummary } from '../../../shared/library'
import { NON_INSERTABLE_KINDS } from '../../../shared/libraryRules'
import { api } from '../../lib/api'
import { navigate } from '../../lib/navigate'
import { useT } from '../../lib/i18n'
import { Button } from '../ui/button'
import { Modal, ModalActions, ModalLede, ModalTitle } from '../ui/modal'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { CanvasSearchModal } from '../CanvasSearchModal'

/** Where the gallery was opened from: a canvas, its selected frame and that frame's name. */
export interface GalleryOrigin {
  from: string
  frame: string | null
  frameName: string | null
}

/** Back on the canvas with the inserted block picked and its box open. */
export function insertedUrl(r: { canvasId: string; frameId: string; elementId: string }, ref: string): string {
  const p = new URLSearchParams({ frame: r.frameId, inserted: r.elementId, ref })
  return `/c/${r.canvasId}?${p}`
}

/**
 * "Use" from the gallery: into the frame selected where the gallery was
 * opened from, or into a canvas and frame picked here. The server inserts;
 * the canvas then opens with the block picked.
 */
export function UseItemButton({
  libraryId,
  item,
  origin,
  size = 'sm',
}: {
  libraryId: string
  item: LibraryItemSummary
  origin: GalleryOrigin | null
  size?: 'sm' | 'md'
}) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState<'canvas' | { canvas: CanvasMeta } | null>(null)
  if (NON_INSERTABLE_KINDS.has(item.kind)) return null

  async function insert(frameId: string) {
    setBusy(true)
    setError(null)
    try {
      const r = await api.insertLibraryItem(libraryId, item.id, { frameId })
      navigate(insertedUrl(r, item.id))
    } catch {
      setError(t('library.useFailed'))
    } finally {
      setBusy(false)
    }
  }

  const label =
    origin?.frame && origin.frameName ? t('library.useIn', { name: origin.frameName }) : t('library.useInCanvas')
  return (
    <>
      <Button
        size={size}
        variant="primary"
        disabled={busy}
        onClick={() => (origin?.frame ? void insert(origin.frame) : setPicking('canvas'))}
      >
        {label}
      </Button>
      {error && (
        <span role="alert" className="text-caption text-accent-ink">
          {error}
        </span>
      )}
      {picking === 'canvas' && (
        <CanvasPick onClose={() => setPicking(null)} onPick={(canvas) => setPicking({ canvas })} />
      )}
      {picking && picking !== 'canvas' && (
        <FramePick
          canvas={picking.canvas}
          onClose={() => setPicking(null)}
          onPick={(frameId) => {
            setPicking(null)
            void insert(frameId)
          }}
        />
      )}
    </>
  )
}

function CanvasPick({ onClose, onPick }: { onClose: () => void; onPick: (canvas: CanvasMeta) => void }) {
  const [canvases, setCanvases] = useState<CanvasMeta[]>([])
  useEffect(() => {
    api
      .listCanvases()
      .then(setCanvases)
      .catch(() => {})
  }, [])
  return <CanvasSearchModal canvases={canvases} onOpen={onPick} onClose={onClose} />
}

function FramePick({
  canvas,
  onClose,
  onPick,
}: {
  canvas: CanvasMeta
  onClose: () => void
  onPick: (frameId: string) => void
}) {
  const t = useT()
  const [frames, setFrames] = useState<Frame[] | null>(null)
  const [picked, setPicked] = useState('')
  useEffect(() => {
    api
      .getCanvas(canvas.id)
      .then((c) => setFrames(c.frames.filter((f) => !f.locked)))
      .catch(() => setFrames([]))
  }, [canvas.id])
  return (
    <Modal size="sm" onClose={onClose}>
      <ModalTitle>{t('library.pickFrameTitle')}</ModalTitle>
      <ModalLede>{canvas.name}</ModalLede>
      <div className="mt-4">
        <Select value={picked} onValueChange={setPicked}>
          <SelectTrigger className="w-full" aria-label={t('library.pickFrameTitle')}>
            <SelectValue placeholder={t('library.pickFramePlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            {(frames ?? []).map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <ModalActions>
        <Button onClick={onClose}>{t('library.cancel')}</Button>
        <Button variant="primary" disabled={!picked} onClick={() => onPick(picked)}>
          {t('library.insert')}
        </Button>
      </ModalActions>
    </Modal>
  )
}
