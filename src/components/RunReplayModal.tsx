import { useEffect, useState } from 'react'
import type { Frame, FrameVersion } from '../../shared/types'
import type { RunFrameChange, RunTimeline } from '../../shared/runReplay'
import { ApiError, api, errorMessage } from '../lib/api'
import { recordServerChange } from '../lib/history'
import { useStore } from '../lib/store'
import { timeAgo } from '../lib/time'
import { useT } from '../lib/i18n'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { ConfirmDialog } from './ui/alert-dialog'
import { ListItem, ListMeta, ListSection, ListSummary } from './ui/list'
import { Modal, ModalActions, ModalLede, ModalSpacer, ModalTitle } from './ui/modal'

/** Width of one side of a before/after pair. */
const SIDE_W = 300

type Shown = Pick<FrameVersion, 'html' | 'width' | 'height'>

/** One resident run, replayed: its activity in order, then every frame it
 *  touched as it was before the run and as the run left it. */
export function RunReplayModal({ canvasId, runId, onClose }: { canvasId: string; runId: string; onClose: () => void }) {
  const t = useT()
  const [timeline, setTimeline] = useState<RunTimeline | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [conflicts, setConflicts] = useState<string[] | null>(null)

  useEffect(() => {
    let live = true
    api
      .runTimeline(canvasId, runId)
      .then((next) => live && setTimeline(next))
      .catch((err: unknown) => live && setError(errorMessage(err, t('replay.failed'))))
    return () => {
      live = false
    }
  }, [canvasId, runId, t])

  /* one undo step for the whole run: the server restored and removed the
     frames, the history only records the inverse */
  async function rollback(force: boolean) {
    setBusy(true)
    setError('')
    try {
      const result = await api.rollbackRun(canvasId, runId, force)
      const state = useStore.getState()
      for (const { frame } of result.restored) state.upsertFrame(frame)
      recordServerChange(result.restored, result.deleted)
      const count = result.restored.length + result.deleted.length
      state.pushNotice(count > 0 ? t('replay.rollbackDone', { count }) : t('replay.rollbackNothing'))
      onClose()
    } catch (err) {
      setBusy(false)
      const listed = err instanceof ApiError && err.status === 409 ? err.body.conflicts : undefined
      if (Array.isArray(listed)) {
        setConflicts(listed.map((c: { name?: unknown }) => String(c.name ?? '')))
        return
      }
      setError(errorMessage(err, t('replay.rollbackFailed')))
    }
  }

  const agent = timeline?.run?.agent ?? timeline?.events[0]?.actorName ?? ''
  return (
    <Modal size="xl" onClose={onClose}>
      <ModalTitle className="break-words">{t('replay.title', { agent })}</ModalTitle>
      <ModalLede>
        {timeline?.run ? `${timeline.run.label} · ${timeAgo(timeline.run.startedAt)}` : t('replay.lede')}
      </ModalLede>
      {error && <p className="mt-2 text-body text-muted-foreground">{error}</p>}
      {!timeline && !error && <ModalLede>{t('replay.loading')}</ModalLede>}
      {timeline && (
        <div className="mt-3 max-h-[60vh] overflow-y-auto">
          <ListSection>{t('replay.timeline')}</ListSection>
          {timeline.events.length === 0 && <ListMeta className="px-4">{t('replay.noEvents')}</ListMeta>}
          {timeline.events.map((e) => (
            <ListItem key={e.id}>
              {/* the feed's line reads on from its actor ("Diazo is working on…") */}
              <ListSummary>
                <span className="font-medium text-ink">{e.actorName}</span> {e.message}
              </ListSummary>
              <ListMeta>{new Date(e.at).toLocaleTimeString()}</ListMeta>
            </ListItem>
          ))}
          <ListSection>{t('replay.frames')}</ListSection>
          {timeline.frames.length === 0 && <ListMeta className="px-4">{t('replay.noFrames')}</ListMeta>}
          {timeline.frames.map((change) => (
            <FrameDiff key={change.frameId} change={change} />
          ))}
        </div>
      )}
      <ModalActions>
        <Button variant="ghost" onClick={onClose}>
          {t('replay.close')}
        </Button>
        <ModalSpacer />
        {timeline && timeline.frames.some((f) => f.exists) && (
          <Button variant="primary" disabled={busy} onClick={() => void rollback(false)}>
            {busy ? t('replay.rollingBack') : t('replay.rollback')}
          </Button>
        )}
      </ModalActions>
      <ConfirmDialog
        open={conflicts !== null}
        onOpenChange={(open) => !open && setConflicts(null)}
        title={t('replay.rollbackConflictTitle')}
        description={t('replay.rollbackConflictDescription', { names: (conflicts ?? []).join(', ') })}
        confirmLabel={t('replay.rollbackAnyway')}
        destructive
        onConfirm={() => {
          setConflicts(null)
          void rollback(true)
        }}
      />
    </Modal>
  )
}

/** A frame's before and after, side by side. */
function FrameDiff({ change }: { change: RunFrameChange }) {
  const t = useT()
  const live = useStore((s) => s.canvas?.frames.find((f) => f.id === change.frameId))
  const before = useVersion(change.frameId, change.beforeVersionId)
  const afterVersion = useVersion(change.frameId, change.afterVersionId)
  const after: Shown | null | undefined = change.afterVersionId ? afterVersion : live ? shownOf(live) : null
  return (
    <div className="border-b border-line-soft px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-body font-medium">{change.name}</span>
        {change.created && <Badge tone="outline">{t('replay.createdByRun')}</Badge>}
        {!change.exists && <Badge tone="outline">{t('replay.deletedSince')}</Badge>}
        {change.editedSince && <Badge tone="outline">{t('replay.editedSince')}</Badge>}
      </div>
      <div className="mt-2 flex gap-3">
        <Side label={t('replay.before')} shown={change.created ? null : before} />
        <Side label={t('replay.after')} shown={after} />
      </div>
    </div>
  )
}

function shownOf(f: Frame): Shown {
  return { html: f.html, width: f.width, height: f.height }
}

/** undefined while loading, null when there is nothing to show */
function useVersion(frameId: string, versionId: string | undefined): Shown | null | undefined {
  const [loaded, setLoaded] = useState<{ id: string; shown: Shown | null } | null>(null)
  useEffect(() => {
    if (!versionId) return
    let live = true
    api
      .frameVersion(frameId, versionId)
      .then((v) => live && setLoaded({ id: versionId, shown: v }))
      .catch(() => live && setLoaded({ id: versionId, shown: null }))
    return () => {
      live = false
    }
  }, [frameId, versionId])
  if (!versionId) return null
  return loaded?.id === versionId ? loaded.shown : undefined
}

/** One side: the design at its own size, scaled to fit; no scripts run. */
function Side({ label, shown }: { label: string; shown: Shown | null | undefined }) {
  const scale = shown ? Math.min(1, SIDE_W / shown.width) : 1
  return (
    <figure className="flex min-w-0 flex-1 flex-col gap-1">
      <figcaption className="text-caption text-muted-foreground">{label}</figcaption>
      <div
        className="overflow-hidden rounded-card border border-border bg-white"
        style={{ width: SIDE_W, height: shown ? Math.min(shown.height * scale, 260) : 80 }}
      >
        {shown && (
          <iframe
            className="pointer-events-none origin-top-left border-0"
            title={label}
            srcDoc={shown.html}
            sandbox=""
            tabIndex={-1}
            style={{ width: shown.width, height: shown.height, transform: `scale(${scale})` }}
          />
        )}
      </div>
    </figure>
  )
}
