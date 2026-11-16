import { useRef, useState } from 'react'
import { pageFrames } from '../../../shared/pages'
import { useT } from '@/lib/i18n'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { motionApi } from '@/lib/motion/api'
import { prepareStage } from '@/lib/motion/compositor'
import { FPS_PRESETS, type Composition, type RenderFormat, type RenderTarget } from '@/lib/motion/contract'
import {
  browserMime,
  hasDesktopRender,
  renderInBrowser,
  renderOnDesktop,
  type RenderProgress,
} from '@/lib/motion/render'
import { errorMessage } from '@/lib/api'
import { Button } from '../ui/button'
import { Modal, ModalActions, ModalLede, ModalTitle } from '../ui/modal'
import { Progress } from '../ui/progress'
import { Segmented, SegmentedItem } from '../ui/segmented'
import { ChoiceRow } from '../ui/choice-list'
import { DesktopIcon, WebIcon } from '../ui/icons'

const SIZES = [
  { label: '1080p', width: 1920, height: 1080 },
  { label: '720p', width: 1280, height: 720 },
  { label: '4K', width: 3840, height: 2160 },
] as const

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; progress: RenderProgress }
  | { kind: 'done'; url: string }
  | {
      kind: 'failed'
      error: string
    }

/**
 * 19 · Export: format, size, rate, range and where the film renders — this
 * browser (MediaRecorder over the compositor) or the desktop app (frame by
 * frame with ffmpeg) when the shell advertises it. 20 · Rendering & done: the
 * progress, then the file.
 */
export function MotionExportDialog({
  comp,
  canvasId,
  pageId,
  playhead,
  onClose,
}: {
  comp: Composition
  canvasId: string
  pageId: string
  playhead: number
  onClose: () => void
}) {
  const t = useT()
  const desktop = hasDesktopRender()
  const [format, setFormat] = useState<RenderFormat>(browserMime('mp4') || desktop ? 'mp4' : 'webm')
  const [size, setSize] = useState<string>(SIZES.find((s) => s.width === comp.width)?.label ?? '1080p')
  const [fps, setFps] = useState(comp.fps)
  const [range, setRange] = useState<'all' | 'from'>('all')
  const [target, setTarget] = useState<RenderTarget>(desktop ? 'desktop' : 'browser')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const abort = useRef<AbortController | null>(null)

  const unsupported = target === 'browser' && !browserMime(format)
  const running = phase.kind === 'running'

  async function render() {
    const picked = SIZES.find((s) => s.label === size) ?? SIZES[0]
    const controller = new AbortController()
    abort.current = controller
    setPhase({ kind: 'running', progress: { phase: 'prepare', progress: 0 } })
    try {
      const { job } = await motionApi.createRender(canvasId, pageId, {
        format,
        target,
        width: picked.width,
        height: picked.height,
        fps,
        range: { start: range === 'from' ? Math.min(playhead, comp.duration - 1 / fps) : 0, end: comp.duration },
      })
      const onProgress = (progress: RenderProgress) => setPhase({ kind: 'running', progress })
      let url: string
      if (target === 'desktop') {
        url = (await renderOnDesktop(job, onProgress)).url
      } else {
        const canvas = useStore.getState().canvas
        const frames = canvas ? pageFrames(canvas, pageId) : []
        const ground = getComputedStyle(document.documentElement).getPropertyValue('--ground').trim() || '#eef0f2'
        const stage = await prepareStage(comp, frames, {
          signal: controller.signal,
          ground,
          onFrame: (done, total) =>
            setPhase({ kind: 'running', progress: { phase: 'prepare', progress: (done / total) * 0.05 } }),
        })
        url = (await renderInBrowser(job, comp, stage, onProgress, controller.signal)).url
      }
      setPhase({ kind: 'done', url })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setPhase({ kind: 'idle' })
        return
      }
      console.error(err)
      setPhase({ kind: 'failed', error: errorMessage(err, err instanceof Error ? err.message : String(err)) })
    }
  }

  const progressLabel = (p: RenderProgress) =>
    p.phase === 'prepare'
      ? t('motion.preparing')
      : p.phase === 'capture'
        ? t('motion.capturing', { percent: Math.round(p.progress * 100) })
        : p.phase === 'encode'
          ? t('motion.encoding')
          : t('motion.uploading')

  return (
    <Modal size="md" onClose={() => (running ? abort.current?.abort() : onClose())}>
      <ModalTitle>{t('motion.exportTitle')}</ModalTitle>
      <ModalLede>{t('motion.exportCaption')}</ModalLede>
      <div className="mt-4 grid grid-cols-[110px_1fr] items-center gap-x-4 gap-y-3 text-body">
        <span className="text-label font-medium">{t('motion.format')}</span>
        <Segmented value={format} onValueChange={(v) => setFormat(v as RenderFormat)} className="w-fit">
          <SegmentedItem value="mp4">MP4</SegmentedItem>
          <SegmentedItem value="webm">WebM</SegmentedItem>
        </Segmented>
        <span className="text-label font-medium">{t('motion.size')}</span>
        <Segmented value={size} onValueChange={setSize} className="w-fit">
          {SIZES.map((s) => (
            <SegmentedItem key={s.label} value={s.label}>
              {s.label}
            </SegmentedItem>
          ))}
        </Segmented>
        <span className="text-label font-medium">{t('motion.rate')}</span>
        <Segmented value={String(fps)} onValueChange={(v) => setFps(Number(v))} className="w-fit">
          {FPS_PRESETS.map((rate) => (
            <SegmentedItem key={rate} value={String(rate)}>
              {rate}
            </SegmentedItem>
          ))}
        </Segmented>
        <span className="text-label font-medium">{t('motion.range')}</span>
        <Segmented value={range} onValueChange={(v) => setRange(v as 'all' | 'from')} className="w-fit">
          <SegmentedItem value="all">{t('motion.rangeAll')}</SegmentedItem>
          <SegmentedItem value="from" disabled={playhead <= 0}>
            {t('motion.rangeFrom')}
          </SegmentedItem>
        </Segmented>
      </div>
      <p className="mt-4 mb-1.5 text-label font-medium">{t('motion.where')}</p>
      <div className="flex flex-col overflow-hidden rounded-card shadow-ring">
        {(
          [
            ['browser', t('motion.whereBrowser'), t('motion.whereBrowserBody'), false],
            [
              'desktop',
              t('motion.whereDesktop'),
              desktop ? t('motion.whereDesktopBody') : t('motion.whereDesktopMissing'),
              !desktop,
            ],
          ] as const
        ).map(([value, title, body, disabled]) => (
          <ChoiceRow
            key={value}
            icon={
              <span className="grid size-8 place-items-center rounded-control bg-well text-ink-2">
                {value === 'desktop' ? <DesktopIcon className="size-4" /> : <WebIcon className="size-4" />}
              </span>
            }
            title={title}
            description={body}
            aria-pressed={target === value}
            disabled={disabled}
            className={cn(target === value && 'bg-signal-wash')}
            onClick={() => setTarget(value)}
            trailing={target === value ? <span className="text-caption font-semibold text-signal">✓</span> : <span />}
          />
        ))}
      </div>
      {unsupported && (
        <p className="mt-2 text-label text-danger">
          ! {t('motion.formatUnsupported', { format: format.toUpperCase() })}
        </p>
      )}
      {phase.kind === 'running' && (
        <div className="mt-4 flex flex-col gap-1.5" role="status" aria-live="polite">
          <Progress value={Math.round(phase.progress.progress * 100)} />
          <span className="text-caption text-agent-ink">{progressLabel(phase.progress)}</span>
        </div>
      )}
      {phase.kind === 'failed' && (
        <p className="mt-4 text-label text-danger">! {t('motion.failed', { error: phase.error })}</p>
      )}
      {phase.kind === 'done' && (
        <p className="mt-4 flex items-center gap-2 text-label text-ok">
          <span aria-hidden className="size-2 rounded-full bg-ok" />
          {t('motion.done')}
        </p>
      )}
      <ModalActions>
        <Button variant="ghost" onClick={() => (running ? abort.current?.abort() : onClose())}>
          {t('motion.cancel')}
        </Button>
        {phase.kind === 'done' ? (
          <Button variant="primary" asChild>
            <a href={phase.url} download>
              {t('motion.download')}
            </a>
          </Button>
        ) : (
          <Button variant="primary" disabled={running || unsupported} onClick={() => void render()}>
            {t('motion.render')}
          </Button>
        )}
      </ModalActions>
    </Modal>
  )
}
