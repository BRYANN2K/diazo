import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { useStore } from '@/lib/store'
import { currentRunnerPick } from '@/lib/runnerPick'
import { useReducedMotion } from '@/lib/motion'
import {
  cameraKeyTimes,
  cameraTrack,
  frameStateAt,
  NEW_COMPOSITION,
  resolveEasing,
  timecode,
  type Composition,
} from '@/lib/motion/contract'
import { pageFrames } from '../../../shared/pages'
import { setFrameMotion } from '@/lib/frameBridge'
import { sendWs } from '@/lib/ws'
import { isScene } from '@/lib/motion/compositor'
import { frameMotionCss } from '@/lib/motion/elementCss'
import { useMotionStore } from '@/lib/motion/store'
import { cameraToViewport, stageBox, viewportToCamera } from '@/lib/motion/stageCamera'
import { useComposition } from '@/lib/motion/useComposition'
import { Button } from '../ui/button'
import { IconButton } from '../ui/icon-button'
import { Skeleton } from '../ui/skeleton'
import { Pressable } from '../ui/pressable'
import { MinusIcon, PauseIcon, PlayIcon, SkipBackIcon, XIcon } from '../ui/icons'
import { MotionExportDialog } from './MotionExportDialog'

/** the label column of every lane, as 04 · Timeline editor draws it */
const LABEL_W = 150

/**
 * Motion Studio's timeline island (18 Motion Studio · MotionTimeline): the
 * transport (play, timecode, length), the tools, a ruler, the lanes and one
 * playhead. The page's frames are the stage; the camera lane's keys move the
 * editor's own view while the film plays or is scrubbed, so what you see on
 * the stage is the shot. Under reduced motion the camera cuts from key to
 * key instead of gliding.
 */
export function MotionTimeline({
  canvasId,
  pageId,
  pageName,
  onClose,
  style,
  className,
  onToast,
}: {
  canvasId: string
  pageId: string
  pageName: string
  onClose: () => void
  style?: CSSProperties
  className?: string
  onToast: (message: string) => void
}) {
  const t = useT()
  const { state, create, patch } = useComposition(canvasId, pageId)
  const comp = state.status === 'ready' ? state.composition : null
  const [time, setTime] = useState(0)
  /* the playhead for the player loop, which starts from wherever it rests */
  const timeRef = useRef(0)
  const [playing, setPlaying] = useState(false)
  const [exporting, setExporting] = useState(false)
  const reduced = useReducedMotion()
  const setViewport = useStore((s) => s.setViewport)

  /* show the shot at `at` on the stage */
  /* the frames the film moves on the stage, put back as saved on close */
  const touched = useRef(new Set<string>())
  const lastSent = useRef(0)
  useEffect(
    () => () => {
      for (const frameId of touched.current) setFrameMotion(frameId, null, '')
      touched.current.clear()
    },
    [pageId],
  )

  const showShot = useCallback(
    (film: Composition, at: number, isPlaying = false) => {
      const keys = cameraKeyTimes(film)
      /* reduced motion: hold each key until the next one (a cut, not a glide) */
      const shown = reduced ? ([...keys].reverse().find((k) => k <= at) ?? at) : at
      const state = frameStateAt(film, shown, { resolveEasing })
      const box = stageBox()
      if (box && state.camera) setViewport(cameraToViewport(state.camera, film, box))
      /* element tracks and seek-safe scenes step inside the live frames */
      const canvas = useStore.getState().canvas
      for (const frame of canvas ? pageFrames(canvas, pageId) : []) {
        const css = frameMotionCss(state, frame.id)
        if (!css && !isScene(frame.html) && !touched.current.has(frame.id)) continue
        touched.current.add(frame.id)
        setFrameMotion(frame.id, state.t, css)
      }
      /* the playhead is presence: collaborators see where this one is */
      const now = performance.now()
      if (now - lastSent.current > 120 || !isPlaying) {
        lastSent.current = now
        sendWs({ type: 'composition:playhead', pageId, t: state.t, playing: isPlaying })
      }
    },
    [reduced, setViewport, pageId],
  )

  const seek = useCallback(
    (at: number) => {
      if (!comp) return
      const clamped = Math.min(Math.max(at, 0), comp.duration)
      timeRef.current = clamped
      setTime(clamped)
      showShot(comp, clamped)
    },
    [comp, showShot],
  )

  /* the player owns the clock; the picture is only ever a function of t */
  useEffect(() => {
    if (!playing || !comp) return
    let frame = 0
    const startedAt = performance.now()
    const from = timeRef.current >= comp.duration ? 0 : timeRef.current
    const tick = (now: number) => {
      const at = from + (now - startedAt) / 1000
      if (at >= comp.duration) {
        timeRef.current = comp.duration
        setTime(comp.duration)
        showShot(comp, comp.duration)
        setPlaying(false)
        return
      }
      timeRef.current = at
      setTime(at)
      showShot(comp, at, true)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, comp, showShot])

  async function write(run: () => Promise<'ok' | 'conflict'>) {
    try {
      if ((await run()) === 'conflict') onToast(t('motion.conflict'))
    } catch (err) {
      console.error(err)
      onToast(t('motion.writeFailed'))
    }
  }

  function keyCameraHere() {
    if (!comp) return
    const box = stageBox()
    if (!box) return
    const camera = viewportToCamera(useStore.getState().viewport, comp, box)
    void write(() =>
      patch([
        {
          op: 'set_camera',
          t: Math.round(time * 1000) / 1000,
          x: camera.x,
          y: camera.y,
          zoom: camera.zoom,
          easing: { type: 'token', name: '--ease-in-out' },
        },
      ]),
    )
  }

  function removeKeysAt(at: number) {
    const track = cameraTrack(comp)
    if (!track) return
    const ops = (track.keyframes ?? [])
      .filter((k) => Math.abs(k.t - at) < 0.001)
      .map((k) => ({ op: 'remove_keyframe' as const, trackId: track.id, keyframeId: k.id }))
    if (ops.length) void write(() => patch(ops))
  }

  async function animateStoryboard() {
    try {
      await api.addCard(
        canvasId,
        t('motion.animatePrompt', {
          page: pageName,
          pageId,
          duration: comp?.duration ?? NEW_COMPOSITION.duration,
        }),
        ['doop'],
        [],
        undefined,
        currentRunnerPick(),
      )
      onToast(t('motion.animateQueued'))
    } catch (err) {
      console.error(err)
      onToast(t('motion.writeFailed'))
    }
  }

  const keys = cameraKeyTimes(comp)
  const onKey = keys.find((k) => Math.abs(k - time) < 0.001)

  return (
    <section
      aria-label={t('motion.timelineAria')}
      data-slot="motion-timeline"
      className={cn(
        '@container pointer-events-auto absolute z-[45] flex h-[232px] flex-col overflow-hidden rounded-panel bg-paper text-label text-ink shadow-panel animate-enter',
        className,
      )}
      style={style}
    >
      <header className="flex h-[42px] flex-none items-center gap-2 border-b border-line px-2.5 whitespace-nowrap">
        <IconButton
          variant="primary"
          shape="round"
          aria-label={playing ? t('motion.pause') : t('motion.play')}
          disabled={!comp}
          onClick={() => setPlaying((p) => !p)}
          className="size-7 active:scale-[0.97]"
        >
          {playing ? <PauseIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
        </IconButton>
        <IconButton size="sm" aria-label={t('motion.toStart')} disabled={!comp} onClick={() => seek(0)}>
          <SkipBackIcon className="size-3.5" />
        </IconButton>
        <span className="min-w-[68px] font-mono text-copy font-medium tabular-nums">
          {timecode(time, comp?.fps ?? NEW_COMPOSITION.fps)}
        </span>
        {comp && (
          <span className="font-mono text-caption text-ink-3 @max-[820px]:hidden">
            {t('motion.length', {
              duration: comp.duration,
              fps: comp.fps,
              width: comp.width,
              height: comp.height,
            })}
          </span>
        )}
        <span aria-hidden className="h-[18px] w-px flex-none bg-line" />
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          {comp && (
            <Button size="sm" className="flex-none" title={t('motion.addKeyTitle')} onClick={keyCameraHere}>
              {t('motion.addKey')}
            </Button>
          )}
          {comp && onKey !== undefined && (
            /* the longest label in the strip folds to its glyph on a narrow timeline */
            <Button
              size="sm"
              variant="ghost"
              className="flex-none"
              title={t('motion.removeKey')}
              onClick={() => removeKeysAt(onKey)}
            >
              <MinusIcon className="hidden size-3.5 @max-[760px]:block" />
              <span className="@max-[760px]:sr-only">{t('motion.removeKey')}</span>
            </Button>
          )}
        </div>
        {/* the agent action sits with Export, out of the strip that clips when
            the timeline runs narrow (MotionTimeline frame) */}
        <Button
          size="sm"
          variant="agent"
          className="flex-none"
          title={t('motion.animateTitle')}
          onClick={() => void animateStoryboard()}
        >
          {t('motion.animate')}
        </Button>
        {comp && (
          <Button size="sm" onClick={() => setExporting(true)}>
            {t('motion.export')}
          </Button>
        )}
        <IconButton size="sm" aria-label={t('motion.close')} onClick={onClose}>
          <XIcon className="size-4" />
        </IconButton>
      </header>

      {state.status === 'loading' && (
        <div className="flex flex-col gap-2 p-3" aria-label={t('motion.loading')}>
          <Skeleton className="h-6" />
          <Skeleton index={1} className="h-6" />
          <Skeleton index={2} className="h-6" />
        </div>
      )}
      {state.status === 'error' && <p className="p-4 text-body text-danger">! {t('motion.loadFailed')}</p>}
      {state.status === 'ready' && !comp && (
        <div className="flex flex-1 flex-col items-start justify-center gap-2 px-5">
          <b className="font-display text-heading font-semibold">{t('motion.emptyTitle')}</b>
          <p className="max-w-[62ch] text-body text-ink-2">{t('motion.emptyBody')}</p>
          <div className="mt-1 flex gap-2">
            <Button variant="primary" onClick={() => void create({ ...NEW_COMPOSITION })}>
              {t('motion.create')}
            </Button>
            <Button variant="agent" onClick={() => void animateStoryboard()}>
              {t('motion.animate')}
            </Button>
          </div>
        </div>
      )}
      {comp && <Lanes comp={comp} time={time} pageId={pageId} onSeek={seek} onPickKey={seek} />}

      {exporting && comp && (
        <MotionExportDialog
          comp={comp}
          canvasId={canvasId}
          pageId={pageId}
          playhead={time}
          onClose={() => setExporting(false)}
        />
      )}
    </section>
  )
}

/** the ruler, the lanes and the playhead; a press anywhere on them scrubs */
function Lanes({
  comp,
  time,
  pageId,
  onSeek,
  onPickKey,
}: {
  comp: Composition
  time: number
  pageId: string
  onSeek: (t: number) => void
  onPickKey: (t: number) => void
}) {
  const t = useT()
  /* collaborators' playheads on this film, in their presence colour */
  const playheads = useMotionStore((s) => s.playheads)
  const presences = useStore((s) => s.presences)
  /* only people still in the room */
  const peers = Object.values(playheads).filter((p) => p.pageId === pageId && presences[p.clientId])
  const body = useRef<HTMLDivElement>(null)
  const scrubbing = useRef(false)
  const keys = cameraKeyTimes(comp)
  const pct = (at: number) => `${(at / comp.duration) * 100}%`
  const seconds = Array.from({ length: Math.floor(comp.duration) + 1 }, (_, i) => i)
  const step = comp.duration > 60 ? 10 : comp.duration > 20 ? 5 : 1

  function at(e: PointerEvent<HTMLDivElement>) {
    const el = body.current
    if (!el) return 0
    const box = el.getBoundingClientRect()
    const x = e.clientX - box.left - LABEL_W
    return (Math.min(Math.max(x, 0), box.width - LABEL_W) / (box.width - LABEL_W)) * comp.duration
  }

  const elementTracks = comp.tracks.filter((track) => track.kind === 'element')
  const lane = 'relative min-w-0 border-b border-[color-mix(in_srgb,var(--line)_50%,transparent)]'
  const head = 'flex items-center gap-1.75 overflow-hidden border-r border-line px-3 whitespace-nowrap text-ink-2'

  return (
    <div
      ref={body}
      className="relative min-h-0 flex-1 cursor-ew-resize touch-none overflow-y-auto"
      onPointerDown={(e) => {
        if ((e.target as Element).closest('[data-key]')) return
        scrubbing.current = true
        e.currentTarget.setPointerCapture(e.pointerId)
        onSeek(at(e))
      }}
      onPointerMove={(e) => scrubbing.current && onSeek(at(e))}
      onPointerUp={() => (scrubbing.current = false)}
      onPointerCancel={() => (scrubbing.current = false)}
    >
      <div className="grid h-6 border-b border-line" style={{ gridTemplateColumns: `${LABEL_W}px 1fr` }}>
        <span className={cn(head, 'font-mono text-micro text-ink-3')}>{timecode(time, comp.fps)}</span>
        <div className="relative min-w-0">
          {seconds
            .filter((s) => s % step === 0)
            .map((s) => (
              <i
                key={s}
                className="absolute inset-y-0 border-l border-line pt-1 pl-1 font-mono text-micro not-italic text-ink-3"
                style={{ left: pct(s) }}
              >
                {s}s
              </i>
            ))}
        </div>
      </div>
      <div className="grid h-[26px]" style={{ gridTemplateColumns: `${LABEL_W}px 1fr` }}>
        <span className={cn(head, 'font-medium text-ink')}>{t('motion.camera')}</span>
        <div className={lane}>
          {keys.length === 0 && (
            <span className="absolute inset-y-0 left-2 flex items-center text-caption text-ink-3">
              {t('motion.noCamera')}
            </span>
          )}
          {keys.length > 1 && (
            <span
              aria-hidden
              className="absolute top-1/2 h-0.5 -translate-y-1/2 bg-signal opacity-50"
              style={{ left: pct(keys[0] ?? 0), width: pct((keys[keys.length - 1] ?? 0) - (keys[0] ?? 0)) }}
            />
          )}
          {keys.map((k) => (
            <Pressable
              key={k}
              layout="inline"
              focus="ring"
              data-key
              aria-label={t('motion.keyAt', { time: timecode(k, comp.fps) })}
              title={t('motion.keyAt', { time: timecode(k, comp.fps) })}
              onClick={() => onPickKey(k)}
              className={cn(
                'absolute top-1/2 size-[9px] -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-none p-0',
                Math.abs(k - time) < 0.001 ? 'bg-signal' : 'bg-surface shadow-[inset_0_0_0_1.5px_var(--signal)]',
              )}
              style={{ left: pct(k) }}
            />
          ))}
        </div>
      </div>
      <div className="grid h-[26px]" style={{ gridTemplateColumns: `${LABEL_W}px 1fr` }}>
        <span className={head}>{t('motion.shots')}</span>
        <div className={lane}>
          {keys.slice(0, -1).map((k, i) => {
            const next = keys[i + 1] ?? comp.duration
            return (
              <span
                key={k}
                className="absolute inset-y-1 flex items-center overflow-hidden rounded-tag bg-surface px-1.5 font-mono text-micro whitespace-nowrap text-ink-2 shadow-[inset_0_0_0_1px_var(--line)]"
                style={{ left: pct(k), width: `calc(${pct(next - k)} - 2px)` }}
              >
                {i + 1}
              </span>
            )
          })}
        </div>
      </div>
      {elementTracks.map((track) => (
        <div key={track.id} className="grid h-[26px]" style={{ gridTemplateColumns: `${LABEL_W}px 1fr` }}>
          <span className={head}>{track.name ?? `${t('motion.element')} ${track.elementId ?? ''}`}</span>
          <div className={lane}>
            {(track.keyframes ?? []).map((k) => (
              <span
                key={k.id}
                aria-hidden
                className="absolute top-1/2 size-[9px] -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-none bg-signal"
                style={{ left: pct(k.t) }}
              />
            ))}
          </div>
        </div>
      ))}
      {peers.map((peer) => {
        const who = presences[peer.clientId]
        return (
          <span
            key={peer.clientId}
            title={who?.name}
            className="pointer-events-none absolute top-0 bottom-0 z-[2] w-px opacity-70"
            style={{
              left: `calc(${LABEL_W}px + (100% - ${LABEL_W}px) * ${Math.min(1, peer.t / comp.duration)})`,
              background: who?.kind === 'agent' ? 'var(--agent)' : (who?.color ?? 'var(--ink-3)'),
            }}
          />
        )
      })}
      <span
        aria-hidden
        className="pointer-events-none absolute top-0 bottom-0 z-[3] w-px bg-signal before:absolute before:top-0 before:-left-[5px] before:h-[13px] before:w-[11px] before:rounded-b-tag before:bg-signal before:content-['']"
        style={{ left: `calc(${LABEL_W}px + (100% - ${LABEL_W}px) * ${time / comp.duration})` }}
      />
    </div>
  )
}
