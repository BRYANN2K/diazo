import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { DRAFT_OPTIONS, DRAFTS_STORAGE_KEY, isDraftCount, readStoredDrafts, type DraftCount } from '../lib/homePrompt'
import { setPromptBoxHidden, usePromptBoxHidden } from '../lib/homePreferences'
import { DiazoMark } from './Logo'
import { ModelPicker } from './ModelPicker'
import { BrandMark } from './ui/brand-mark'
import { IconButton } from './ui/icon-button'
import { Chip } from './ui/chip'
import { MenuButton } from './ui/menu-button'
import { Pressable } from './ui/pressable'
import { Textarea } from './ui/textarea'
import { Button } from './ui/button'
import { Modal, ModalActions, ModalLede, ModalTitle } from './ui/modal'
import {
  DropdownMenu,
  DropdownMenuCaption,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import {
  ArrowUpIcon,
  AttachmentIcon,
  BlocksIcon,
  ChevronRightIcon,
  CirclePlusIcon,
  CopyIcon,
  LayoutTemplateIcon,
  UploadIcon,
  WebIcon,
  XIcon,
} from './ui/icons'
import { useT, type PlainMessageKey } from '../lib/i18n'

/**
 * The home page's front door: the Diazo mark revealing itself, a greeting, a strip of
 * suggestion chips, the composer that starts a canvas from a prompt, and the
 * "connect your designs" bar under it — all over the brand's gradient wave.
 *
 * The composer does not design on this page. A send makes a new canvas, queues
 * the brief as its first board card and opens it, where the agent's work
 * streams in. The draft count asks for that many takes on the same brief.
 */

export interface HeroActions {
  onPrompt: (text: string, drafts: DraftCount) => Promise<void> | void
  onImport: () => void
  onConnectAgents: () => void
  onAutomations: () => void
  onIntegrations: () => void
  onCommunity: () => void
}

/** a chip either fills the composer with a brief or runs an action */
interface Chip {
  id: string
  label: PlainMessageKey
  icon: ReactNode
  prompt?: PlainMessageKey
  action?: keyof Omit<HeroActions, 'onPrompt'>
}

const chipIcon = { width: 13, height: 13 } as const

const CHIPS: Chip[] = [
  {
    id: 'landing',
    label: 'home.chipLanding',
    icon: <LayoutTemplateIcon {...chipIcon} />,
    prompt: 'home.chipLandingPrompt',
  },
  {
    id: 'automation',
    label: 'home.chipAutomation',
    icon: <span className="font-mono text-caption">/</span>,
    action: 'onAutomations',
  },
  { id: 'agents', label: 'home.chipAgents', icon: <CirclePlusIcon {...chipIcon} />, action: 'onConnectAgents' },
  { id: 'import', label: 'home.chipImport', icon: <UploadIcon {...chipIcon} />, action: 'onImport' },
  {
    id: 'integrations',
    label: 'home.chipIntegrations',
    icon: <BlocksIcon {...chipIcon} />,
    action: 'onIntegrations',
  },
  { id: 'templates', label: 'home.chipTemplates', icon: <WebIcon {...chipIcon} />, action: 'onCommunity' },
]

/** the beam walks the strip while nobody hovers, like a slow carousel */
const MAX_COMPOSER_LINES = 6

function autosize(ta: HTMLTextAreaElement) {
  ta.style.height = 'auto'
  if (!ta.scrollHeight) return
  const line = parseFloat(getComputedStyle(ta).lineHeight) || 22
  ta.style.height = `${Math.min(ta.scrollHeight, Math.round(line * MAX_COMPOSER_LINES))}px`
}

export function HomeHero({
  firstName,
  busy,
  actions,
  focusAt,
}: {
  firstName?: string
  /** a send in flight: the composer locks until the canvas opens */
  busy: boolean
  actions: HeroActions
  /** a timestamp — the rail's "Ask Doop" and ⌘/ ask for the keyboard */
  focusAt: number
}) {
  const hidden = usePromptBoxHidden()
  const [confirmHide, setConfirmHide] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [text, setText] = useState('')
  const [drafts, setDrafts] = useState<DraftCount>(() =>
    readStoredDrafts(typeof localStorage === 'undefined' ? undefined : localStorage),
  )
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const t = useT()

  useLayoutEffect(() => {
    if (inputRef.current) autosize(inputRef.current)
  }, [text])

  useEffect(() => {
    if (focusAt) inputRef.current?.focus()
  }, [focusAt])

  function pickDrafts(n: DraftCount) {
    setDrafts(n)
    try {
      localStorage.setItem(DRAFTS_STORAGE_KEY, String(n))
    } catch {
      /* private mode: the choice lives for this page only */
    }
  }

  function submit() {
    const trimmed = text.trim()
    if (!trimmed || busy) return
    void actions.onPrompt(trimmed, drafts)
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  function runChip(chip: Chip) {
    if (chip.action) return actions[chip.action]()
    if (chip.prompt) {
      setText(t(chip.prompt))
      inputRef.current?.focus()
    }
  }

  if (hidden) return null

  return (
    /* a dotted bench card: the canvas ground the product works on, with the
       agent's mark, the greeting, the composer and a row of suggestions */
    <section
      className="relative mx-3 overflow-hidden rounded-panel bg-paper bg-[radial-gradient(var(--dot)_1px,transparent_1px)] bg-size-[16px_16px] pb-10 shadow-ring md:mx-8"
      data-slot="home-hero"
    >
      <IconButton
        aria-label={t('home.hidePromptBox')}
        className="absolute top-3 right-3 z-10 text-ink-3"
        disabled={busy}
        onClick={() => setConfirmHide(true)}
      >
        <XIcon className="size-4" />
      </IconButton>
      {confirmHide && (
        <Modal
          size="sm"
          onClose={() => setConfirmHide(false)}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            cancelRef.current?.focus()
          }}
        >
          <ModalTitle>{t('home.hidePromptBoxTitle')}</ModalTitle>
          <ModalLede>{t('home.hidePromptBoxLede')}</ModalLede>
          <ModalActions>
            <Button ref={cancelRef} onClick={() => setConfirmHide(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setConfirmHide(false)
                setPromptBoxHidden(true)
              }}
            >
              {t('home.hidePromptBox')}
            </Button>
          </ModalActions>
        </Modal>
      )}
      <div className="relative px-4 pt-10 text-center md:pt-14">
        <span className="mx-auto mb-4 block size-[40px] text-ink md:mb-5 md:size-[44px]">
          <DiazoMark animated size="fill" className="block" />
        </span>
        <h1 className="font-display text-title font-semibold leading-none text-ink md:text-display">
          {t('home.greeting')}
          {firstName ? ', ' : ''}
          {firstName}
        </h1>
      </div>

      {/* the composer */}
      <div className="relative mx-auto mt-6 w-full max-w-[740px] px-4 md:mt-7 md:px-0">
        <div className="rounded-card bg-surface pt-3 pr-2.5 pb-2 pl-3 shadow-ring transition-shadow duration-fast focus-within:shadow-[0_0_0_1px_var(--signal),0_0_0_3px_var(--signal-wash)]">
          <Textarea
            ref={inputRef}
            variant="bare"
            rows={1}
            value={text}
            disabled={busy}
            placeholder={t('home.composerPlaceholder')}
            aria-label={t('home.composerAria')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            className="min-h-[46px] text-copy placeholder:text-ink-3 md:text-copy"
          />
          <div className="mt-1 flex items-center gap-3 text-body text-ink-soft md:gap-5">
            <Pressable
              layout="inline"
              focus="ring"
              className="gap-[7px] rounded-row text-ink-soft transition-colors hover:text-ink"
              onClick={actions.onImport}
              title={t('home.attachTitle')}
            >
              <AttachmentIcon width={14} height={14} /> {t('home.files')}
            </Pressable>
            <span className="flex-1" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <MenuButton
                  variant="quiet"
                  aria-label={t('home.draftsAria', { count: drafts })}
                  className="whitespace-nowrap"
                  icon={<CopyIcon width={14} height={14} />}
                >
                  {t('home.drafts', { count: drafts })}
                </MenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="end" width="md">
                <DropdownMenuCaption>{t('home.draftsCaption')}</DropdownMenuCaption>
                <DropdownMenuRadioGroup
                  value={String(drafts)}
                  onValueChange={(next) => {
                    const n = Number(next)
                    if (isDraftCount(n)) pickDrafts(n)
                  }}
                >
                  {DRAFT_OPTIONS.map((n) => (
                    <DropdownMenuRadioItem
                      key={n}
                      value={String(n)}
                      description={t('home.draftsDescription', { count: n })}
                    >
                      {t('home.drafts', { count: n })}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <ModelPicker disabled={busy} />
            <IconButton
              variant="primary"
              size="lg"
              shape="round"
              aria-label={t('home.send')}
              disabled={busy || !text.trim()}
              onClick={submit}
            >
              <ArrowUpIcon width={14} height={14} strokeWidth={1.75} />
            </IconButton>
          </div>
        </div>
        <Pressable
          focus="ring"
          onClick={actions.onIntegrations}
          className="group mx-[14px] flex w-[calc(100%-28px)] items-center rounded-b-card bg-sub px-5 pb-2.5 pt-3 text-body text-ink-soft transition-colors hover:text-ink"
        >
          {t('home.connectDesigns')}
          <ChevronRightIcon
            width={12}
            height={12}
            className="ml-1.5 -translate-x-0.5 text-ink-faint opacity-0 blur-[2px] transition-[opacity,transform,filter] duration-fast ease-out-quad group-hover:translate-x-0 group-hover:opacity-100 group-hover:blur-none motion-reduce:transition-none"
            aria-hidden
          />
          {/* the marks rest a little faded and desaturated; the bar's hover wakes the
              row, and the mark under the pointer comes fully to life and lifts */}
          <span
            className="marks ml-auto flex items-center gap-[9px] [&>*]:opacity-75 [&>*]:saturate-[.8] [&>*]:transition-[opacity,filter,transform] [&>*]:duration-fast [&>*]:ease-out-quad group-hover:[&>*]:opacity-90 group-hover:[&>*]:saturate-[.95] [&>*:hover]:-translate-y-px [&>*:hover]:!opacity-100 [&>*:hover]:!saturate-100 motion-reduce:[&>*]:transition-none"
            aria-hidden
          >
            <span className="grid size-4 place-items-center rounded-tag bg-surface shadow-ring">
              <BrandMark brand="figma" size={12} />
            </span>
            <BrandMark brand="github" size={16} className="text-ink" />
            <BrandMark brand="canva" size={16} />
            <BrandMark brand="photoshop" size={16} />
          </span>
        </Pressable>
      </div>
      {/* suggestions under the composer, as the redesign lays them out */}
      <div className="relative mx-auto mt-4 hidden max-w-[740px] flex-wrap justify-center gap-1.5 px-4 md:flex">
        {CHIPS.map((chip) => (
          <Chip key={chip.id} icon={chip.icon} onClick={() => runChip(chip)}>
            {t(chip.label)}
          </Chip>
        ))}
      </div>
    </section>
  )
}
