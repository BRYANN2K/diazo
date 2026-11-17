import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { DownloadIcon, XIcon } from '@/components/ui/icons'
import { type UpdateOffer, listenForUpdates, restartToUpdate } from '@/lib/desktopUpdate'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { ServerUpdateCard } from './ServerUpdateCard'

/** The desktop shell's "Update available" card (src/lib/desktopUpdate.ts):
 *  mounted once over every screen, empty until the shell offers an update. */
export function UpdateCard() {
  const [offer, setOffer] = useState<UpdateOffer | null>(null)
  useEffect(() => listenForUpdates(setOffer), [])
  /* the live region stays mounted so the card is announced when it appears,
     without taking focus from whatever the person is doing */
  return (
    /* bottom right, one toast's height above where toasts sit: on the canvas
       --float-right / --float-bottom (CanvasPage) keep both clear of the open
       panels and the zoom pill, elsewhere they sit in the window's corner */
    <div
      aria-live="polite"
      className="fixed right-[var(--float-right,14px)] bottom-[calc(var(--float-bottom,0px)+58px)] z-[80] flex flex-col items-end gap-2"
    >
      {/* the server's own "newer build" card (admins, a local install), in a
          browser and in the app alike; above the shell's when both show */}
      <ServerUpdateCard />
      {offer && <UpdateCardControls offer={offer} onLater={() => setOffer(null)} />}
    </div>
  )
}

function UpdateCardControls({ offer, onLater }: { offer: UpdateOffer; onLater: () => void }) {
  const [restarting, setRestarting] = useState(false)
  return (
    <UpdateCardView
      version={offer.version}
      restarting={restarting}
      onRestart={() => {
        setRestarting(true)
        restartToUpdate()
          .catch(console.error)
          .finally(() => setRestarting(false))
      }}
      /* the download stays with the shell: offered again by the next check
         and, on macOS, installed on quit */
      onLater={onLater}
    />
  )
}

type UpdateCardViewProps = {
  version: string
  restarting?: boolean
  onRestart: () => void
  onLater: () => void
  className?: string
}

export function UpdateCardView({ version, restarting = false, onRestart, onLater, className }: UpdateCardViewProps) {
  const t = useT()
  /* the canvas's getting-started card in shape (src/components/Onboarding.tsx):
     a titled panel with its dismiss in the header */
  return (
    <section
      aria-labelledby="update-card-title"
      aria-describedby="update-card-body"
      className={cn(
        'flex w-[320px] flex-col gap-2.5 rounded-panel bg-surface p-3.5 shadow-pop animate-[toast-in_400ms_var(--spring-soft)_both]',
        className,
      )}
    >
      <header className="flex items-center justify-between">
        <h2 id="update-card-title" className="flex items-center gap-2 text-body font-semibold text-ink">
          <DownloadIcon size="rail" className="text-signal" aria-hidden />
          {t('shell.updateTitle')}
        </h2>
        <IconButton
          size="sm"
          className="-mr-1"
          aria-label={t('shell.updateLater')}
          disabled={restarting}
          onClick={onLater}
        >
          <XIcon size="rail" />
        </IconButton>
      </header>
      <div className="flex flex-col gap-1">
        <p id="update-card-body" className="text-pretty text-body text-ink-soft">
          {t('shell.updateBody', { version })}
        </p>
        <p className="text-pretty text-caption text-ink-faint">{t('shell.updateAgentNote')}</p>
      </div>
      <Button variant="primary" size="sm" className="self-start" disabled={restarting} onClick={onRestart}>
        {restarting ? t('shell.updateRestarting') : t('shell.updateRestart')}
      </Button>
    </section>
  )
}
