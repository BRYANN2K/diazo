import { useEffect, useMemo, useState } from 'react'
import type { Frame } from '../../shared/types'
import { DEV_TASK_AGENTS, DEV_TASK_TERMINAL, type DevTask, type DevTaskState } from '../../shared/devTasks'
import { canEditOpenCanvas, useStore } from '../lib/store'
import { api, errorMessage } from '../lib/api'
import { DEV_TASK_STATE_KEYS, devTasksForFrame, latestDevTaskForFrame } from '../lib/devTasks'
import { hasOrca, orcaActivate, orcaStatus, type OrcaStatus } from '../lib/orca'
import { getLocale, useT } from '../lib/i18n'
import { cn } from '@/lib/utils'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Tooltip } from './ui/tooltip'
import { CheckIcon, ClockIcon, ExportIcon, HelpIcon, WorkflowIcon, XIcon } from './ui/icons'

/* the rail's filled buttons — the same fill the Inspector's own rows use */
const fillBtn = 'h-7 rounded-row bg-sub px-2 text-label font-normal text-ink hover:bg-paper-deep max-md:min-h-10'

/* the Select's "no environment" value — Radix items may not be '' */
const THIS_MAC = 'this-mac'

const STATE_TONE = {
  queued: 'agent',
  starting: 'agent',
  working: 'agent',
  needs_input: 'caution',
  pr_open: 'signal',
  done: 'success',
  failed: 'danger',
  cancelled: 'default',
} as const satisfies Record<DevTaskState, string>

const STATE_ICON = {
  queued: ClockIcon,
  starting: ClockIcon,
  working: WorkflowIcon,
  needs_input: HelpIcon,
  pr_open: ExportIcon,
  done: CheckIcon,
  failed: XIcon,
  cancelled: XIcon,
} as const satisfies Record<DevTaskState, typeof ClockIcon>

/** One line naming the run: the agent, where it runs and who asked. */
function taskTitle(task: DevTask): string {
  return `${task.agent} · ${task.hostLabel}`
}

function taskMeta(task: DevTask): string {
  const date = new Date(task.createdAt).toLocaleString(getLocale())
  return `${taskTitle(task)} · ${task.requestedBy} · ${date}`
}

/** The frame title's dev-task chip: the newest launch's state, sitting with
 *  the approval and check badges. */
export function DevTaskBadge({ frame }: { frame: Frame }) {
  const t = useT()
  const task = useStore((s) => latestDevTaskForFrame(s.devTasks, frame.id))
  if (!task) return null
  const label = t(DEV_TASK_STATE_KEYS[task.state])
  const detail = `${t('devTasks.badgeTitle')} · ${label} · ${taskMeta(task)}`
  const Icon = STATE_ICON[task.state]
  /* the only dev-task surface a view-only participant ever sees (the
     Inspector needs edit access), so it doubles as the AC-9 PR link */
  const prUrl = task.prUrl && /^https?:\/\//.test(task.prUrl) ? task.prUrl : null
  const badge = (
    <Badge
      tone={STATE_TONE[task.state]}
      className="shrink-0"
      title={detail}
      aria-label={`${t('devTasks.badgeTitle')} · ${label}`}
    >
      <Icon className="size-3" aria-hidden />
      {label}
    </Badge>
  )
  return (
    <Tooltip label={detail} side="top" align="start">
      {prUrl ? (
        <a
          href={prUrl}
          target="_blank"
          rel="noreferrer"
          className="flex shrink-0"
          title={detail}
          aria-label={`${t('devTasks.badgeTitle')} · ${label}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {badge}
        </a>
      ) : (
        badge
      )}
    </Tooltip>
  )
}

/** One task in the Build card: state chip, who/where, summary, and the
 *  actions the role allows (PR link for everyone; Open in Orca on the shell
 *  that launched it; cancel for editors while it runs). */
function DevTaskRow({ task, frame }: { task: DevTask; frame: Frame }) {
  const t = useT()
  const canEdit = useStore(canEditOpenCanvas)
  const pushNotice = useStore((s) => s.pushNotice)
  const [busy, setBusy] = useState<'cancel' | 'open' | null>(null)
  const terminal = DEV_TASK_TERMINAL.includes(task.state)
  const label = t(DEV_TASK_STATE_KEYS[task.state])
  const Icon = STATE_ICON[task.state]
  /* the approval's revision moved past the one this launch signed off */
  const stale =
    task.frameRevision !== null && !!frame.approval && frame.approval.approvedFrameUpdatedAt !== task.frameRevision

  const cancel = async () => {
    setBusy('cancel')
    try {
      await api.cancelDevTask(task.id)
    } catch (error) {
      pushNotice(errorMessage(error, t('devTasks.cancelFailed')))
    } finally {
      setBusy(null)
    }
  }

  const openInOrca = async () => {
    if (!task.orcaIdentity) return
    setBusy('open')
    try {
      await orcaActivate(task.orcaIdentity, task.environment)
    } catch {
      pushNotice(t('devTasks.openInOrcaFailed'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-1 rounded-row border border-line-soft px-2 py-1.5" data-dev-task={task.id}>
      <div className="flex items-center gap-1.5">
        <Badge tone={STATE_TONE[task.state]} className="shrink-0">
          <Icon className="size-3" aria-hidden />
          {label}
        </Badge>
        {!terminal && canEdit && (
          <Button
            variant="bare"
            size="inline"
            className="ml-auto shrink-0 text-ink-faint hover:text-ink"
            title={t('devTasks.cancelTitle')}
            disabled={busy !== null}
            onClick={() => void cancel()}
          >
            {t('devTasks.cancelTask')}
          </Button>
        )}
      </div>
      <span className="truncate text-label text-ink-soft" title={taskMeta(task)}>
        {taskTitle(task)}
      </span>
      {task.summary && <p className="text-caption break-words text-ink-faint">{task.summary}</p>}
      {stale && !terminal && <p className="text-caption text-ink-faint">{t('devTasks.frameChanged')}</p>}
      <div className="flex items-center gap-1.5">
        {task.prUrl && /^https?:\/\//.test(task.prUrl) && (
          <a
            href={task.prUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-caption text-signal hover:underline"
          >
            <ExportIcon className="size-3" aria-hidden />
            {t('devTasks.viewPr')}
          </a>
        )}
        {hasOrca() && task.orcaIdentity && (
          <Button
            variant="bare"
            size="inline"
            className="text-ink-faint hover:text-ink"
            disabled={busy !== null}
            onClick={() => void openInOrca()}
          >
            {t('devTasks.openInOrca')}
          </Button>
        )}
      </div>
      <span className="sr-only" role="status">
        {t('devTasks.statusLine', { state: label })}
      </span>
    </div>
  )
}

/** The launch form: agent (and environment when the shell can name them),
 *  then the send — its errors come back with the server's own actionable
 *  wording (offline grant, missing sign-off, throttling, a brief the frame
 *  could not build) and the button stays as the explicit retry. */
function DevTaskLaunch({ frame }: { frame: Frame }) {
  const t = useT()
  const shell = hasOrca()
  const [status, setStatus] = useState<OrcaStatus | null>(null)
  const [agent, setAgent] = useState<string>(DEV_TASK_AGENTS[0])
  const [environment, setEnvironment] = useState(THIS_MAC)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!shell) return
    let alive = true
    orcaStatus()
      .then((s) => alive && setStatus(s))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [shell])

  /* on the shell only agents with a configured account are offered; the
     status's empty list means none is set up at all */
  const agents: string[] =
    shell && status ? DEV_TASK_AGENTS.filter((a) => status.agents.includes(a)) : [...DEV_TASK_AGENTS]
  const environments = (status?.environments ?? []).filter((e): e is { name: string } => typeof e.name === 'string')
  /* the picked agent may fall out of the configured list — clamp on read */
  const picked = agents.includes(agent) ? agent : (agents[0] ?? agent)

  const send = async () => {
    setSending(true)
    setError(null)
    try {
      await api.createDevTask(frame.id, {
        agent: picked,
        ...(environment !== THIS_MAC ? { environment } : {}),
      })
    } catch (err) {
      setError(errorMessage(err, t('devTasks.launchFailed')))
    } finally {
      setSending(false)
    }
  }

  if (agents.length === 0) return <p className="text-caption text-ink-faint">{t('devTasks.noAgents')}</p>
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-1.5">
        <Select value={picked} onValueChange={setAgent} disabled={sending}>
          <SelectTrigger size="sm" className="min-w-0 flex-1" aria-label={t('devTasks.agent')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {agents.map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {environments.length > 0 && (
          <Select value={environment} onValueChange={setEnvironment} disabled={sending}>
            <SelectTrigger size="sm" className="min-w-0 flex-1" aria-label={t('devTasks.environment')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={THIS_MAC}>{t('devTasks.thisMac')}</SelectItem>
              {environments.map((env) => (
                <SelectItem key={env.name} value={env.name}>
                  {env.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      <Button
        variant="bare"
        className={cn(fillBtn, 'w-full gap-1.5')}
        title={t('devTasks.sendTitle')}
        disabled={sending}
        aria-busy={sending}
        onClick={() => void send()}
      >
        <WorkflowIcon className="size-3.5" aria-hidden />
        {sending ? t('devTasks.sending') : t('devTasks.sendToOrca')}
      </Button>
      {error && (
        <p role="alert" className="text-caption break-words text-danger">
          {error}
        </p>
      )}
    </div>
  )
}

/** The Inspector's Build card body: the frame's tasks newest first, then —
 *  for an editor on a signed-off frame — the launch. Viewers get the read-
 *  only list. */
export function DevTaskSection({ frame }: { frame: Frame }) {
  const canEdit = useStore(canEditOpenCanvas)
  const devTasks = useStore((s) => s.devTasks)
  const tasks = useMemo(() => devTasksForFrame(devTasks, frame.id).slice(0, 5), [devTasks, frame.id])
  const ready = frame.approval?.status === 'ready_for_dev'
  return (
    <div className="flex flex-col gap-2">
      {tasks.map((task) => (
        <DevTaskRow key={task.id} task={task} frame={frame} />
      ))}
      {canEdit && ready && <DevTaskLaunch frame={frame} />}
    </div>
  )
}
