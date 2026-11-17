import { Button } from '@/components/ui/button'
import { CodeBlock } from '@/components/ui/code-block'
import { IconButton } from '@/components/ui/icon-button'
import { DownloadIcon, XIcon } from '@/components/ui/icons'
import { authClient } from '@/lib/auth'
import { type PlainMessageKey, useT } from '@/lib/i18n'
import { dismissUpdate, useDismissedUpdate, useUpdateStatus } from '@/lib/updateStatus'
import { cn } from '@/lib/utils'
import { type InstallType, type UpdateStatus, updateCommand, updateKey } from '../../shared/updateCheck'

/** How many commit titles the card lists before "and N more". */
const LISTED = 3

const HINTS: Record<InstallType, PlainMessageKey> = {
  local: 'updates.hintLocal',
  docker: 'updates.hintDocker',
  kubernetes: 'updates.hintKubernetes',
  source: 'updates.hintSource',
  desktop: 'updates.hintDesktop',
}

/** The server's "Update available" card (server/updateCheck.ts): a newer
 *  build of this instance is out. Mounted beside the desktop shell's own
 *  update card (UpdateCard.tsx), so it shows in a browser and in the app
 *  alike; empty for anyone the server does not answer (not an admin, not a
 *  local install) and once dismissed for that build. */
export function ServerUpdateCard() {
  const { data: session } = authClient.useSession()
  const status = useUpdateStatus(session?.user.id)
  const dismissed = useDismissedUpdate()
  const key = status ? updateKey(status) : null
  if (!status || !key || key === dismissed) return null
  return <ServerUpdateCardView status={status} onDismiss={() => dismissUpdate(key)} />
}

type ServerUpdateCardViewProps = {
  status: UpdateStatus
  onDismiss: () => void
  className?: string
}

export function ServerUpdateCardView({ status, onDismiss, className }: ServerUpdateCardViewProps) {
  const t = useT()
  const vars = { count: status.behindBy, repo: status.repo, branch: status.branch }
  const listed = status.commits.slice(0, LISTED)
  const more = status.behindBy - listed.length
  /* the desktop card's shape (UpdateCard.tsx): a titled panel, its dismiss
     in the header */
  return (
    <section
      aria-labelledby="server-update-title"
      aria-describedby="server-update-body"
      className={cn(
        'flex w-[320px] flex-col gap-2.5 rounded-panel bg-surface p-3.5 shadow-pop animate-[toast-in_400ms_var(--spring-soft)_both]',
        className,
      )}
    >
      <header className="flex items-center justify-between">
        <h2 id="server-update-title" className="flex items-center gap-2 text-body font-semibold text-ink">
          <DownloadIcon size="rail" className="text-signal" aria-hidden />
          {t('updates.cardTitle')}
        </h2>
        <IconButton size="sm" className="-mr-1" aria-label={t('updates.cardDismiss')} onClick={onDismiss}>
          <XIcon size="rail" />
        </IconButton>
      </header>
      <div className="flex flex-col gap-1.5">
        <p id="server-update-body" className="text-pretty text-body text-ink-soft">
          {status.state === 'diverged' ? t('updates.cardDiverged', vars) : t('updates.cardBody', vars)}
        </p>
        {listed.length > 0 && (
          <ul className="flex flex-col gap-0.5">
            {listed.map((commit) => (
              <li key={commit.sha} className="truncate text-caption text-ink-faint" title={commit.title}>
                {commit.title}
              </li>
            ))}
          </ul>
        )}
        {status.compareUrl && (
          <Button variant="link" size="inline" className="self-start text-brand" asChild>
            <a href={status.compareUrl} target="_blank" rel="noreferrer">
              {more > 0 ? `${t('updates.cardMore', { count: more })} · ` : ''}
              {t('updates.seeChanges')}
            </a>
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-caption font-medium text-ink-soft">{t('updates.cardHowTo')}</span>
        <CodeBlock density="rail" text={updateCommand(status.install)} />
        <p className="text-pretty text-caption text-ink-faint">{t(HINTS[status.install])}</p>
      </div>
    </section>
  )
}
