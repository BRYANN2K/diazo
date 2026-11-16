import { useEffect, useState } from 'react'
import type { CanvasMeta } from '../../shared/types'
import type { LibraryListEntry } from '../../shared/library'
import { api } from '../lib/api'
import { navigate } from '../lib/navigate'
import { useT } from '../lib/i18n'
import { AppRail, railLayout } from '../components/AppRail'
import { ConvertToLibraryModal } from '../components/library/ConvertToLibraryModal'
import { CurateLibraryModal } from '../components/library/CurateLibraryModal'
import { NewLibraryModal } from '../components/library/NewLibraryModal'
import { LibraryTile } from '../components/library/LibraryTile'
import { Button } from '../components/ui/button'
import { EmptyState } from '../components/ui/empty-state'
import { PlusIcon } from '../components/ui/icons'
import { Modal, ModalActions, ModalLede, ModalTitle } from '../components/ui/modal'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Skeleton } from '../components/ui/skeleton'
import { DashContent, DashHeader, DashLayout, DashMain, DashTitle } from '../components/ui/dash'

/**
 * Libraries (`/libraries`): every design library this person can use, as
 * tiles, and the way to make one from a canvas.
 */
export function Libraries() {
  const t = useT()
  const [libraries, setLibraries] = useState<LibraryListEntry[] | null>(null)
  const [picking, setPicking] = useState(false)
  const [converting, setConverting] = useState<string | null>(null)
  const [curating, setCurating] = useState(false)
  const [starting, setStarting] = useState(false)

  function load() {
    api
      .listLibraries()
      .then((r) => setLibraries(r.libraries))
      .catch(() => setLibraries([]))
  }
  useEffect(load, [])

  return (
    <DashLayout className={railLayout}>
      <AppRail active="libraries" />
      <DashMain className="[background:var(--paper)]">
        <DashHeader variant="bare">
          <span className="flex-1" />
          <Button size="bar" variant="agent" onClick={() => setCurating(true)} title={t('library.curateHint')}>
            {t('library.curateOpen')}
          </Button>
          <Button variant="primary" size="bar" onClick={() => setStarting(true)}>
            <PlusIcon width={15} height={15} strokeWidth={1.75} /> {t('library.newLibrary')}
          </Button>
        </DashHeader>
        <DashContent className="pt-2 md:pt-3">
          <DashTitle className="mb-5">{t('rail.libraries')}</DashTitle>
          {libraries === null ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} index={i} shape="tile" aspect="16/10" />
              ))}
            </div>
          ) : libraries.length === 0 ? (
            <EmptyState
              title={t('library.emptyTitle')}
              description={t('library.emptyDescription')}
              action={
                <Button variant="primary" onClick={() => setPicking(true)}>
                  {t('library.emptyAction')}
                </Button>
              }
            />
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4" data-testid="library-tiles">
              {libraries.map((library) => (
                <LibraryTile key={library.id} library={library} onOpen={() => navigate(`/l/${library.id}`)} />
              ))}
            </div>
          )}
        </DashContent>
      </DashMain>
      {picking && (
        <CanvasPicker
          onClose={() => setPicking(false)}
          onPick={(id) => {
            setPicking(false)
            setConverting(id)
          }}
          exclude={new Set((libraries ?? []).map((l) => l.id))}
        />
      )}
      {starting && (
        <NewLibraryModal
          onClose={() => setStarting(false)}
          onPath={(path) => {
            setStarting(false)
            if (path === 'canvas') setPicking(true)
            else setCurating(true)
          }}
        />
      )}
      {curating && (
        <CurateLibraryModal
          onClose={() => {
            setCurating(false)
            load()
          }}
        />
      )}
      {converting && (
        <ConvertToLibraryModal canvasId={converting} onClose={() => setConverting(null)} onConverted={load} />
      )}
    </DashLayout>
  )
}

/** Which canvas becomes a library: one of the person's canvases. */
function CanvasPicker({
  onClose,
  onPick,
  exclude,
}: {
  onClose: () => void
  onPick: (canvasId: string) => void
  exclude: ReadonlySet<string>
}) {
  const t = useT()
  const [canvases, setCanvases] = useState<CanvasMeta[] | null>(null)
  const [picked, setPicked] = useState('')
  useEffect(() => {
    api
      .listCanvases()
      .then((list) => setCanvases(list.filter((c) => !exclude.has(c.id))))
      .catch(() => setCanvases([]))
  }, [exclude])
  return (
    <Modal size="sm" onClose={onClose}>
      <ModalTitle>{t('library.pickCanvasTitle')}</ModalTitle>
      <ModalLede>{t('library.pickCanvasLede')}</ModalLede>
      <div className="mt-4">
        <Select value={picked} onValueChange={setPicked}>
          <SelectTrigger className="w-full" aria-label={t('library.pickCanvasTitle')}>
            <SelectValue placeholder={t('library.pickCanvasPlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            {(canvases ?? []).map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <ModalActions>
        <Button onClick={onClose}>{t('library.cancel')}</Button>
        <Button variant="primary" disabled={!picked} onClick={() => onPick(picked)}>
          {t('library.next')}
        </Button>
      </ModalActions>
    </Modal>
  )
}
