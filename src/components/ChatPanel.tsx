import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { ChatMessage, ChatPlan, ChatPlanReference, ChatPlanScreen } from '../../shared/types'
import { colorFor } from '../../shared/types'
import { MAX_CHAT_TEXT_CHARS, chatThreadId, isOpenPlan } from '../../shared/chat'
import { canCommentOpenCanvas, canEditOpenCanvas, useStore } from '../lib/store'
import { api, errorMessage } from '../lib/api'
import { posthog } from '../lib/posthog'
import { timeAgo } from '../lib/time'
import { isComposingEnter } from '../lib/keys'
import { isCanvasElement } from '../lib/drawing'
import { isResidentLimit } from './TeamAllowance'
import { refreshLocalRepo, useLocalRepo } from '../lib/localRepo'
import { ModelPicker } from './ModelPicker'
import { DiazoAgentMark } from './Logo'
import { MenuButton } from './ui/menu-button'
import {
  DropdownMenu,
  DropdownMenuCaption,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { currentRunnerPick } from '../lib/runnerPick'
import { Button } from './ui/button'
import { IconButton } from './ui/icon-button'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'
import { PanelBody } from './ui/panel'
import { Card } from './ui/card'
import { Badge } from './ui/badge'
import { Avatar } from './ui/avatar'
import { Chip } from './ui/chip'
import { Kbd } from './ui/kbd'
import { StatusLabel } from './ui/status-label'
import { HandoffModal } from './HandoffModal'
import { Note } from './ui/note'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ClockIcon,
  EyeIcon,
  FolderIcon,
  LayoutTemplateIcon,
  ReplyIcon,
  SparkIcon,
  SyncIcon,
  XIcon,
} from './ui/icons'
import { useT } from '@/lib/i18n'
import { ThinkingStatus } from './ui/thinking-status'
import { cn } from '@/lib/utils'

/** the field grows with the draft up to this many lines, then scrolls */
const MAX_COMPOSER_LINES = 8
/** within this many px of the end, the list counts as read to the bottom */
const BOTTOM_SLACK_PX = 48
/** a second line by the same author within this window drops its header */
const GROUP_WINDOW_MS = 5 * 60_000
/** the conversation's reading width when the panel is docked wide */
const COLUMN = 'mx-auto w-full max-w-[640px]'

/* feedback and plan launches are metered like any other resident task — a
   403 means the free tier ran out, so raise the connect wall */
/** The composer's model pick rides on every ask, like a prompt-bar card's,
 *  so the chat answers on what the picker beside the send button shows. */
function runnerArg() {
  const runner = currentRunnerPick()
  return runner ? { runner } : {}
}

function reportLimit(err: unknown) {
  if (isResidentLimit(err)) useStore.getState().setLimitWall(true)
  else console.error(err)
}

/** Size the field to its draft, up to MAX_COMPOSER_LINES. */
function autosize(ta: HTMLTextAreaElement) {
  ta.style.height = 'auto'
  if (!ta.scrollHeight) return
  const line = parseFloat(getComputedStyle(ta).lineHeight) || 20
  ta.style.height = `${Math.min(ta.scrollHeight, Math.round(line * MAX_COMPOSER_LINES))}px`
}

function atEnd(el: HTMLElement) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK_PX
}

/** A draft the panel hands the composer (a skill suggestion): `n` makes a
 *  second pick of the same text land again. */
interface ComposerSeed {
  text: string
  n: number
}

/**
 * The canvas chat: where the room talks the next design over with the
 * resident agent before anything touches the canvas. A design ask comes back
 * as a plan card; only an editor's Go design turns it into board cards.
 */
export function ChatPanel({ canvasId }: { canvasId: string }) {
  const chat = useStore((s) => s.chat)
  const canComment = useStore(canCommentOpenCanvas)
  const canEdit = useStore(canEditOpenCanvas)
  const t = useT()
  /* the thread the composer answers in, set from a thread's Reply action */
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null)
  const [seed, setSeed] = useState<ComposerSeed | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  /* whether new lines keep the list pinned to its end: true until the reader
     scrolls up, and again once they come back down or send */
  const stick = useRef(true)
  const [away, setAway] = useState(false)
  /* the newest line the reader has seen at the bottom of the list */
  const [seenId, setSeenId] = useState<string | undefined>(undefined)
  /* thread views: a root and its replies, oldest thread first so the newest
     conversation is the one the scroll lands on */
  const threads = useMemo(() => {
    const byAt = [...chat].reverse()
    const roots = byAt.filter((m) => !m.threadId)
    return roots.map((root) => ({
      root,
      replies: byAt.filter((m) => m.threadId === chatThreadId(root)),
    }))
  }, [chat])
  const latestId = chat[0]?.id
  /* until someone has asked the agent something, the welcome stays above
     the lines */
  const welcome = !chat.some((m) => m.agent || m.forAgent)

  /* follow the conversation while it grows at the bottom, plans and status
     changes included — unless the reader scrolled up to read something */
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [chat])

  function onScroll() {
    const el = scrollRef.current
    if (!el) return
    const end = atEnd(el)
    /* pinned until this scroll, the reader had read down to the newest line */
    if (end || stick.current) setSeenId(latestId)
    stick.current = end
    setAway(!end)
  }

  function jumpToLatest() {
    const el = scrollRef.current
    stick.current = true
    setAway(false)
    setSeenId(latestId)
    if (el) el.scrollTop = el.scrollHeight
  }

  /* a send of one's own always brings the list back down to it */
  function onSent() {
    stick.current = true
    setAway(false)
  }

  async function ask(text: string) {
    onSent()
    await api.sendChat(canvasId, { text, ...runnerArg() })
    posthog.capture('chat_suggestion_sent')
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <LocalProjectChip canvasId={canvasId} />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <PanelBody ref={scrollRef} onScroll={onScroll} className="flex flex-col">
          {welcome && (
            <ChatWelcome
              centered={threads.length === 0}
              canAsk={canEdit}
              onAsk={(text) => ask(text).catch(reportLimit)}
              onSeed={(text) => setSeed((cur) => ({ text, n: (cur?.n ?? 0) + 1 }))}
            />
          )}
          {threads.length > 0 && (
            <div className={cn(COLUMN, 'mt-auto flex flex-col gap-5 px-3 pt-4 pb-3')}>
              {threads.map((thread) => (
                <ChatThread
                  key={thread.root.id}
                  root={thread.root}
                  replies={thread.replies}
                  onReply={canComment ? () => setReplyTo(thread.root) : undefined}
                />
              ))}
            </div>
          )}
        </PanelBody>
        {away && (
          <Button
            size="pill"
            className="absolute bottom-2 left-1/2 -translate-x-1/2 gap-1 py-1 pr-2.5 pl-2 shadow-float hover:shadow-float"
            onClick={jumpToLatest}
          >
            <ArrowDownIcon size={12} />
            {latestId !== seenId ? t('panels.chatNewMessages') : t('panels.chatJumpLatest')}
          </Button>
        )}
      </div>
      {canComment && (
        <ChatComposer
          canvasId={canvasId}
          seed={seed}
          replyTo={replyTo && threads.some((th) => th.root.id === replyTo.id) ? replyTo : null}
          onClearReply={() => setReplyTo(null)}
          onSent={onSent}
        />
      )}
    </div>
  )
}

/** The linked local project, as the chip over the chat: while the asker's
 *  app is open, the agent reads it for the plans it writes here. */
function LocalProjectChip({ canvasId }: { canvasId: string }) {
  const status = useLocalRepo((s) => s.status[canvasId])
  const t = useT()
  useEffect(() => {
    void refreshLocalRepo(canvasId).catch(() => {})
  }, [canvasId])
  if (!status?.link) return null
  return (
    <div className="flex flex-none items-center gap-1.5 border-b border-line-soft px-3 py-1.5">
      <FolderIcon size="rail" className="flex-none text-ink-faint" />
      <b className="min-w-0 truncate text-label font-medium text-ink-soft">{status.link.name}</b>
      <StatusLabel tone={status.online ? 'done' : 'muted'} className="min-w-0 truncate">
        {status.online ? t('panels.chatRepoReading') : t('panels.localProjectOffline')}
      </StatusLabel>
    </div>
  )
}

interface Suggestion {
  key: string
  icon: ReactNode
  label: string
  /** sent as the ask; a skill instead puts `/name` in the composer */
  prompt?: string
  skill?: string
}

/** The suggestions under the welcome, tied to this canvas: the frame in
 *  hand (selected, else the page's first), and the canvas's first skill. */
function useSuggestions(): Suggestion[] {
  const t = useT()
  const frames = useStore((s) => s.canvas?.frames)
  const firstPage = useStore((s) => s.canvas?.pages?.[0]?.id)
  const pageId = useStore((s) => s.activePageId) ?? firstPage
  const selectedId = useStore((s) => s.selectedId)
  const skill = useStore((s) => s.canvas?.skills?.[0]?.name)
  return useMemo(() => {
    const onPage = (frames ?? []).filter((f) => (f.pageId ?? firstPage) === pageId && !isCanvasElement(f.html ?? ''))
    const frame = onPage.find((f) => f.id === selectedId) ?? onPage[0]
    const list: Suggestion[] = [
      {
        key: 'pricing',
        icon: <LayoutTemplateIcon size={12} />,
        label: t('panels.chatSuggestPricing'),
        prompt: t('panels.chatSuggestPricingPrompt'),
      },
      {
        key: 'landing',
        icon: <SparkIcon size={12} />,
        label: t('panels.chatSuggestLanding'),
        prompt: t('panels.chatSuggestLandingPrompt'),
      },
    ]
    if (frame)
      list.push({
        key: 'review',
        icon: <EyeIcon size={12} />,
        label: t('panels.chatSuggestReview', { name: frame.name }),
        prompt: t('panels.chatSuggestReviewPrompt', { name: frame.name }),
      })
    if (skill)
      list.push({
        key: 'skill',
        icon: <span className="font-mono text-micro">/</span>,
        label: t('panels.chatSuggestSkill', { name: skill }),
        skill,
      })
    return list
  }, [frames, firstPage, pageId, selectedId, skill, t])
}

/** What the column shows before the agent has answered: what it does, and
 *  a few asks to start from. Centred when the chat is empty, at the top of
 *  the list when the room has only talked among itself so far. */
function ChatWelcome({
  centered,
  canAsk,
  onAsk,
  onSeed,
}: {
  centered: boolean
  canAsk: boolean
  onAsk: (prompt: string) => void
  onSeed: (text: string) => void
}) {
  const t = useT()
  const suggestions = useSuggestions()
  return (
    <section
      aria-label={t('panels.chatWelcomeTitle')}
      className={cn(COLUMN, 'flex flex-col items-start gap-3 px-4', centered ? 'my-auto py-6' : 'pt-5 pb-1')}
    >
      <DiazoAgentMark size={32} className="block" />
      <div className="flex flex-col gap-1">
        <h3 className="text-copy font-medium text-ink">{t('panels.chatWelcomeTitle')}</h3>
        <p className="text-body text-ink-soft">{canAsk ? t('panels.chatWelcomeBody') : t('panels.chatEmpty')}</p>
      </div>
      {canAsk && (
        <div className="flex max-w-full flex-col items-start gap-1.5 pt-1">
          {suggestions.map((s) => (
            <Chip
              key={s.key}
              icon={s.icon}
              /* a chat suggestion is the panel's content, not a passing
                 hint: barely faded, so it reads in the dark theme too */
              className="max-w-full opacity-90"
              onClick={() => (s.skill ? onSeed(`/${s.skill} `) : s.prompt && onAsk(s.prompt))}
            >
              <span className="min-w-0 truncate">{s.label}</span>
            </Chip>
          ))}
        </div>
      )}
    </section>
  )
}

/** One face: a person's initials on their colour, or the agent's mark. */
function ChatAvatar({ name, agent, glaze }: { name: string; agent?: boolean; glaze?: boolean }) {
  return (
    <Avatar
      name={name}
      kind={agent ? 'agent' : 'user'}
      color={colorFor(name)}
      size={18}
      glaze={glaze}
      className="flex-none shadow-none dark:shadow-none"
    />
  )
}

/** A thread: its root line and the replies under it, one turn of the
 *  conversation. A follow-up is written in the panel's one composer: Reply
 *  points it at this thread. */
function ChatThread({ root, replies, onReply }: { root: ChatMessage; replies: ChatMessage[]; onReply?: () => void }) {
  const t = useT()
  const lines = [root, ...replies]
  return (
    <div className="group/thread relative flex flex-col gap-2">
      {lines.map((message, i) => {
        const prev = lines[i - 1]
        const grouped =
          !!prev &&
          prev.from === message.from &&
          !!prev.agent === !!message.agent &&
          message.at - prev.at < GROUP_WINDOW_MS
        return <ChatLine key={message.id} message={message} grouped={grouped} />
      })}
      {onReply && (
        <IconButton
          size="sm"
          aria-label={t('panels.chatReplyTo', { name: root.from })}
          title={t('panels.chatReplyTo', { name: root.from })}
          /* the corner the root's header leaves free: a person's line is
             on the right, the agent's on the left */
          className={cn(
            'absolute -top-1 opacity-0 transition-opacity group-hover/thread:opacity-100 focus-visible:opacity-100',
            root.agent ? 'right-0' : 'left-0',
          )}
          onClick={onReply}
        >
          <ReplyIcon size="rail" />
        </IconButton>
      )}
    </div>
  )
}

/** When a line was written: quiet, with the full date on hover. */
function Stamp({ at }: { at: number }) {
  return (
    <time
      dateTime={new Date(at).toISOString()}
      title={new Date(at).toLocaleString()}
      className="text-caption text-ink-faint tabular-nums"
    >
      {timeAgo(at)}
    </time>
  )
}

/** One line of the conversation: who and when, then the text — or the plan
 *  card the line carries. An ask shows where it stands under it, in the
 *  agent's place: queued, thinking, or failed with its reason and a Retry. */
function ChatLine({ message, grouped }: { message: ChatMessage; grouped: boolean }) {
  const asking = message.forAgent && !message.answeredAt && !message.failedAt
  /* a person's line is a bubble on the right; the agent's turn is plain
     text beside its mark, with its plan card under it */
  if (!message.agent) {
    return (
      <>
        <div className="flex flex-col items-end gap-1">
          {!grouped && (
            <span className="flex items-center gap-1.5 pr-0.5 text-caption">
              <span className="truncate font-medium text-ink-soft">{message.from}</span>
              <Stamp at={message.at} />
            </span>
          )}
          <div className="max-w-[85%] animate-enter rounded-card rounded-br-tag bg-well px-3 py-2 text-copy break-words whitespace-pre-wrap text-ink">
            {message.text}
          </div>
        </div>
        {asking && <AgentPending message={message} />}
        {message.failedAt && <AskFailed message={message} />}
      </>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      {!grouped && (
        <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
          <ChatAvatar name={message.from} agent />
          <b className="truncate text-body font-medium text-ink">{message.from}</b>
          <Stamp at={message.at} />
        </span>
      )}
      {message.text && (
        <span className="min-w-0 animate-enter pl-6 text-copy break-words whitespace-pre-wrap text-ink">
          {message.text}
        </span>
      )}
      {message.plan && (
        <div className="pl-6">
          <PlanCard message={message} plan={message.plan} />
        </div>
      )}
      {asking && <AgentPending message={message} />}
      {message.failedAt && <AskFailed message={message} />}
    </div>
  )
}

/** The agent's turn while it is still coming: its glazed face and what it is
 *  doing, so the answer has a place to land before it arrives. */
function AgentPending({ message }: { message: ChatMessage }) {
  const t = useT()
  const agent = message.claimedBy ?? message.targetAgent ?? 'Diazo'
  const thinking = !!message.claimedBy
  return (
    <div role="status" className="flex min-w-0 items-center gap-1.5">
      <ChatAvatar name={agent} agent glaze={thinking} />
      {thinking ? (
        /* the agent's live line, in agent orange under the shimmer */
        <ThinkingStatus steps={[t('panels.chatThinking', { agent: message.claimedBy ?? '' })]} className="ml-0.5" />
      ) : (
        <>
          <ClockIcon size={12} className="mx-0.5 flex-none text-ink-3" />
          <span className="min-w-0 truncate text-caption text-ink-3">
            {t('panels.chatQueued', { agent: message.targetAgent ?? '' })}
          </span>
        </>
      )}
    </div>
  )
}

/** An ask the agent could not take: the reason, in the agent's place, and
 *  the Retry an editor can press to queue it again. */
function AskFailed({ message }: { message: ChatMessage }) {
  const canvasId = useStore((s) => s.canvas?.id)
  const canEdit = useStore(canEditOpenCanvas)
  const t = useT()
  return (
    <div className="flex min-w-0 items-start gap-1.5">
      <ChatAvatar name={message.claimedBy ?? message.targetAgent ?? 'Diazo'} agent />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
        <Note tone="error" className="line-clamp-3 min-w-0 break-words">
          {message.failureReason ?? t('panels.chatAskFailed')}
        </Note>
        {canEdit && canvasId && (
          <Button size="pill" className="gap-1" onClick={() => api.retryChatAsk(message.id).catch(reportLimit)}>
            <SyncIcon size={12} />
            {t('panels.chatRetry')}
          </Button>
        )}
      </div>
    </div>
  )
}

/* ---- the plan card ---- */

/* a proposal is the agent's (agent tone), an approval a person's (signal) */
const STATUS_TONES: Record<ChatPlan['status'], 'agent' | 'signal' | 'success' | 'default'> = {
  proposed: 'agent',
  approved: 'signal',
  launched: 'success',
  revised: 'default',
  canceled: 'default',
}

/** A design plan the agent put in chat: what it is for, the screens it
 *  would make, the questions it still owes — and, for editors while it is
 *  open, the buttons that shape or launch it. Go design queues one board
 *  card per screen under the editor's name. */
function PlanCard({ message, plan }: { message: ChatMessage; plan: ChatPlan }) {
  const canvasId = useStore((s) => s.canvas?.id)
  const canEdit = useStore(canEditOpenCanvas)
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [revising, setRevising] = useState(false)
  const [handoffOpen, setHandoffOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const open = isOpenPlan(plan)

  const act = (fn: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    fn()
      .catch(reportLimit)
      .finally(() => setBusy(false))
  }

  return (
    <Card tone="flat" className="mt-1 p-3 text-body">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 font-display text-copy font-semibold text-ink">
          <LayoutTemplateIcon size={14} className="flex-none text-ink-3" />
          {t('panels.chatPlanTitle')}
        </span>
        <Badge tone={STATUS_TONES[plan.status]}>{t(`panels.chatPlanStatus_${plan.status}`)}</Badge>
      </div>
      {editing ? (
        <PlanEditor message={message} plan={plan} busy={busy} onDone={() => setEditing(false)} />
      ) : (
        <>
          <p className="mt-1 break-words whitespace-pre-wrap text-ink">{plan.summary}</p>
          <ul className="mt-1.5 space-y-1">
            {plan.screens.map((screen, i) => (
              <li key={i} className="relative min-w-0 pl-5">
                <span className="absolute top-0 left-0 font-mono text-caption text-ink-3 tabular-nums">{i + 1}</span>
                <div className="flex min-w-0 items-baseline gap-1.5">
                  <span className="min-w-0 truncate font-medium text-ink">{screen.name}</span>
                  <span className="flex-none text-micro text-ink-faint tabular-nums">
                    {screen.width}×{screen.height}
                  </span>
                </div>
                <div className="line-clamp-2 break-words text-ink-soft">{screen.outline}</div>
                {screen.reuse && screen.reuse.length > 0 && (
                  <div className="truncate text-caption text-ink-faint" title={screen.reuse.join(', ')}>
                    {t('panels.chatPlanReuse', { items: screen.reuse.join(', ') })}
                  </div>
                )}
                {screen.references && screen.references.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {screen.references.map((ref) => (
                      <PlanReference
                        key={ref.libraryId}
                        reference={ref}
                        removable={open && canEdit}
                        busy={busy}
                        onRemove={() => act(() => api.removeChatPlanReference(message.id, i, ref.libraryId))}
                      />
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {plan.openQuestions && plan.openQuestions.length > 0 && (
            <div className="mt-1.5 border-t border-line-soft pt-1.5">
              <span className="text-caption font-medium text-ink-faint">{t('panels.chatPlanQuestions')}</span>
              <ul className="mt-0.5 space-y-0.5 text-ink-soft">
                {plan.openQuestions.map((q, i) => (
                  <li key={i} className="break-words">
                    {q}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {plan.status === 'launched' && (
            <div className="mt-1.5 flex items-center gap-1.5 border-t border-line-soft pt-1.5 text-caption text-ink-faint">
              <CheckIcon size="rail" className="flex-none" />
              <span className="min-w-0 truncate">
                {t('panels.chatPlanLaunched', {
                  count: plan.taskIds?.length ?? plan.screens.length,
                  name: plan.launchedBy ?? '',
                })}
              </span>
              {canEdit && canvasId && (
                <Button
                  variant="bare"
                  size="pill"
                  className="ml-auto flex-none"
                  title={t('handoff.actionTitle')}
                  onClick={() => setHandoffOpen(true)}
                >
                  {t('handoff.action')}
                </Button>
              )}
            </div>
          )}
          {open && canEdit && (
            /* the actions wrap at a narrow panel (260px, longer pt-BR labels):
               Revise and Go design stay together on the right */
            <div className="mt-2.5 flex flex-wrap items-center gap-x-1 gap-y-1.5 border-t border-line-soft pt-2">
              <Button
                variant="ghost"
                size="sm"
                className="text-ink-3"
                disabled={busy}
                title={t('panels.chatPlanCancelTitle')}
                onClick={() => act(() => api.cancelChatPlan(message.id))}
              >
                {t('panels.chatPlanCancel')}
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(true)}>
                {t('panels.chatPlanEdit')}
              </Button>
              <span className="ml-auto flex items-center gap-1">
                <Button
                  size="sm"
                  disabled={busy}
                  title={t('panels.chatPlanReviseTitle')}
                  onClick={() => setRevising((v) => !v)}
                >
                  {t('panels.chatPlanRevise')}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy}
                  title={t('panels.chatPlanLaunchTitle')}
                  onClick={() =>
                    act(() => api.launchChatPlan(message.id).then(() => posthog.capture('chat_plan_launched')))
                  }
                >
                  {t('panels.chatPlanLaunch')}
                </Button>
              </span>
            </div>
          )}
          {open && revising && canEdit && canvasId && <ReviseField canvasId={canvasId} message={message} />}
          {handoffOpen && canvasId && (
            <HandoffModal
              canvasId={canvasId}
              input={{ planMessageId: message.id }}
              onClose={() => setHandoffOpen(false)}
            />
          )}
        </>
      )}
    </Card>
  )
}

/** One library reference on a plan card: a thumbnail of the frame the
 *  screen will build on, its label and ids, a link that opens it — and,
 *  while the plan is open, the button that drops it from the plan. */
function PlanReference({
  reference,
  removable,
  busy,
  onRemove,
}: {
  reference: ChatPlanReference
  removable: boolean
  busy: boolean
  onRemove: () => void
}) {
  const t = useT()
  return (
    <div className="group relative w-24 flex-none overflow-hidden rounded-control bg-paper shadow-ring">
      <a
        href={`/c/${reference.canvasId}?frame=${reference.frameId}`}
        target="_blank"
        rel="noreferrer"
        title={`${reference.label} — ${reference.why}`}
        className="block transition-shadow focus-visible:shadow-elevation-1-focus hover:shadow-elevation-1-hover"
      >
        <img
          src={
            reference.itemId
              ? `/api/libraries/${reference.canvasId}/items/${encodeURIComponent(reference.itemId)}/thumb.jpg`
              : `/i/${reference.frameId}.jpg?preview`
          }
          onError={(e) => {
            /* an item with no image yet: the frame's preview stands in */
            const fallback = `/i/${reference.frameId}.jpg?preview`
            if (!e.currentTarget.src.endsWith(fallback)) e.currentTarget.src = fallback
          }}
          alt={reference.label}
          loading="lazy"
          className="block aspect-[4/3] w-full object-cover object-top"
        />
        <span className="block truncate px-1.5 pt-0.5 text-micro font-medium text-ink">{reference.label}</span>
        <span className="block truncate px-1.5 pb-1 font-mono text-micro text-ink-faint">{reference.frameId}</span>
      </a>
      {removable && (
        <IconButton
          variant="frosted"
          shape="round"
          size="sm"
          disabled={busy}
          aria-label={t('panels.chatPlanRemoveReference')}
          onClick={onRemove}
          className="absolute top-0.5 right-0.5 size-5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        >
          <XIcon size="rail" />
        </IconButton>
      )}
    </div>
  )
}

/** "Ask for changes": a line to the agent in the plan's own thread. The new
 *  plan it posts supersedes this one — that is what Revise means here. */
function ReviseField({ canvasId, message }: { canvasId: string; message: ChatMessage }) {
  const t = useT()
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)

  async function send() {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setFailed(false)
    try {
      /* routed like the composer: the @mention turns it into an ask, the
         thread ties the next plan to this one */
      await api.sendChat(canvasId, { text: `@Diazo ${text}`, threadId: message.id, ...runnerArg() })
      setDraft('')
    } catch (err) {
      setFailed(true)
      reportLimit(err)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="mt-1.5">
      <Input
        variant="bare"
        inputSize="auto"
        className="h-7 w-full rounded-row bg-paper px-2.5 shadow-ring focus:shadow-elevation-1-focus"
        placeholder={t('panels.chatPlanRevisePlaceholder')}
        value={draft}
        disabled={sending}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !isComposingEnter(e)) void send()
        }}
      />
      {failed && (
        <Note tone="error" size="sm" className="mt-1">
          {t('panels.chatSendFailed')}
        </Note>
      )}
    </div>
  )
}

/** The editor's version of the plan: its summary, and each screen's name
 *  and outline. Saving marks it approved — a person shaped it. */
function PlanEditor({
  message,
  plan,
  busy,
  onDone,
}: {
  message: ChatMessage
  plan: ChatPlan
  busy: boolean
  onDone: () => void
}) {
  const t = useT()
  const [summary, setSummary] = useState(plan.summary)
  const [screens, setScreens] = useState<ChatPlanScreen[]>(plan.screens)

  const save = () => {
    const next = {
      summary: summary.trim(),
      screens,
      ...(plan.openQuestions ? { openQuestions: plan.openQuestions } : {}),
    }
    if (!next.summary || next.screens.length === 0) return
    api.editChatPlan(message.id, next).then(onDone).catch(reportLimit)
  }

  return (
    <div className="mt-1.5 space-y-1.5">
      <Textarea
        variant="well"
        rows={2}
        aria-label={t('panels.chatPlanEditSummary')}
        className="text-body"
        value={summary}
        disabled={busy}
        onChange={(e) => setSummary(e.target.value)}
      />
      {screens.map((screen, i) => (
        <div key={i} className="rounded-control bg-paper px-2 py-1 shadow-ring">
          <Input
            variant="bare"
            inputSize="auto"
            aria-label={t('panels.chatPlanEditScreenName')}
            className="h-6 w-full font-medium"
            value={screen.name}
            disabled={busy}
            onChange={(e) => setScreens((cur) => cur.map((s, j) => (j === i ? { ...s, name: e.target.value } : s)))}
          />
          <Textarea
            variant="bare"
            rows={2}
            aria-label={t('panels.chatPlanEditScreenOutline')}
            className="w-full text-ink-soft"
            value={screen.outline}
            disabled={busy}
            onChange={(e) => setScreens((cur) => cur.map((s, j) => (j === i ? { ...s, outline: e.target.value } : s)))}
          />
          <span className="text-micro text-ink-faint tabular-nums">
            {screen.width}×{screen.height}
          </span>
        </div>
      ))}
      <div className="flex items-center gap-1 pt-0.5">
        <Button variant="primary" size="pill" disabled={busy || !summary.trim()} onClick={save}>
          {t('panels.chatPlanSave')}
        </Button>
        <Button variant="bare" size="pill" disabled={busy} onClick={onDone}>
          {t('panels.chatPlanCancelEdit')}
        </Button>
      </div>
    </div>
  )
}

/** The composer docked under the conversation: a message to the room, or an
 *  @mention to the agent — same field, the server tells them apart. */
function ChatComposer({
  canvasId,
  seed,
  replyTo,
  onClearReply,
  onSent,
}: {
  canvasId: string
  /** a draft handed down by the welcome (a skill to start from) */
  seed: ComposerSeed | null
  /** the thread a send answers in; null starts a new thread */
  replyTo: ChatMessage | null
  onClearReply: () => void
  onSent: () => void
}) {
  const canEdit = useStore(canEditOpenCanvas)
  const t = useT()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  /* a seed replaces the draft once per pick */
  const [seenSeed, setSeenSeed] = useState(seed)
  if (seed !== seenSeed) {
    setSeenSeed(seed)
    if (seed) setText(seed.text)
  }

  useLayoutEffect(() => {
    if (inputRef.current) autosize(inputRef.current)
  }, [text])

  /* Reply on a thread, or a picked suggestion, puts the keyboard here */
  useEffect(() => {
    if (replyTo || seed) inputRef.current?.focus()
  }, [replyTo, seed])

  async function submit() {
    const clean = text.trim()
    if (!clean || sending) return
    setSending(true)
    setError(null)
    try {
      onSent()
      await api.sendChat(canvasId, { text: clean, ...(replyTo ? { threadId: replyTo.id } : {}), ...runnerArg() })
      posthog.capture('chat_message_sent')
      setText('')
      onClearReply()
    } catch (err) {
      setError(errorMessage(err, t('panels.chatSendFailed')))
      reportLimit(err)
    } finally {
      setSending(false)
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    /* ↩ and ⌘↩ send, ⇧↩ breaks the line */
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    } else if (e.key === 'Escape' && replyTo) {
      e.preventDefault()
      onClearReply()
    }
  }

  /* a picked skill goes in front of the ask as /name, once; a lone "/" the
     person typed to look for one is the slot it takes */
  function pickSkill(name: string) {
    setText((current) => {
      if (current.includes(`/${name}`)) return current
      const rest = current.trim() === '/' ? '' : current
      return `/${name} ${rest}`.trimEnd() + ' '
    })
    inputRef.current?.focus()
  }

  const ready = !!text.trim() && !sending
  return (
    <form
      className="shrink-0 px-2.5 pt-1.5 pb-2.5"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div
        className={cn(
          COLUMN,
          'flex cursor-text flex-col gap-1.5 rounded-panel bg-surface px-3 pt-2.5 pb-2 shadow-ring',
          'transition-shadow duration-normal ease-out-quad focus-within:shadow-elevation-1-focus',
        )}
        onClick={(e) => {
          /* the whole box is the field's target, not only its text lines */
          if (e.target === e.currentTarget) inputRef.current?.focus()
        }}
      >
        {replyTo && (
          <span className="flex min-w-0 items-center gap-1 self-start rounded-pill bg-sub py-0.5 pr-0.5 pl-2 text-caption text-ink-soft">
            <ReplyIcon size={12} className="flex-none text-ink-faint" />
            <span className="min-w-0 truncate">
              {t('panels.chatReplyingTo', { name: replyTo.from, text: replyTo.text.slice(0, 60) })}
            </span>
            <IconButton
              size="sm"
              className="size-5 flex-none"
              aria-label={t('panels.chatReplyCancel')}
              onClick={onClearReply}
            >
              <XIcon size={12} />
            </IconButton>
          </span>
        )}
        <Textarea
          ref={inputRef}
          variant="bare"
          rows={2}
          maxLength={MAX_CHAT_TEXT_CHARS}
          aria-label={t('panels.chatAria')}
          className="block min-h-10 overflow-y-auto px-0.5 text-copy placeholder:text-ink-faint"
          value={text}
          disabled={sending}
          placeholder={
            replyTo
              ? t('panels.chatReplyPlaceholder')
              : canEdit
                ? t('panels.chatPlaceholderAgent')
                : t('panels.chatPlaceholder')
          }
          onKeyDown={onKeyDown}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="@container/foot flex min-w-0 items-center gap-1">
          {canEdit && <SkillMenu disabled={sending} onPick={pickSkill} />}
          {canEdit && <ModelPicker disabled={sending} />}
          <span className="flex-1" />
          {ready && (
            <span aria-hidden className="flex flex-none items-center gap-1 pr-1 text-caption text-ink-faint">
              <Kbd>↩</Kbd>
            </span>
          )}
          <IconButton
            variant="primary"
            size="md"
            shape="round"
            type="submit"
            aria-label={sending ? t('panels.chatSending') : t('panels.chatSend')}
            title={t('panels.chatSendTitle')}
            disabled={!ready}
            /* at rest the button is a quiet well, not a dimmed ink disc that
               reads as muddy grey on the dark surface */
            className="disabled:bg-paper-deep disabled:text-ink-faint disabled:opacity-100"
          >
            <ArrowUpIcon className={cn(sending && 'animate-pulse')} />
          </IconButton>
        </div>
      </div>
      {error && (
        <Note tone="error" size="sm" className={cn(COLUMN, 'mt-1.5')}>
          {error}
        </Note>
      )}
    </form>
  )
}

/** The composer's "/" menu: the canvas's skills, each with when to use it.
 *  Picking one writes /name into the ask, which loads it for the agent. */
function SkillMenu({ disabled, onPick }: { disabled: boolean; onPick: (name: string) => void }) {
  const skills = useStore((s) => s.canvas?.skills ?? [])
  const t = useT()
  if (!skills.length) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <MenuButton
          variant="quiet"
          disabled={disabled}
          aria-label={t('panels.skillMenu')}
          title={t('panels.skillMenu')}
        >
          <span className="font-mono">/</span>
        </MenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" width="lg">
        <DropdownMenuCaption>{t('panels.skills')}</DropdownMenuCaption>
        {skills.map((skill) => (
          <DropdownMenuItem key={skill.name} description={skill.description} onSelect={() => onPick(skill.name)}>
            <span className="font-mono">/{skill.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
