import type { BuildInfo } from '../../shared/buildInfo'
import { shortSha } from '../../shared/buildInfo'
import type { UpdateStatus } from '../../shared/updateCheck'
import { authClient } from '../lib/auth'
import { useBuildInfo } from '../lib/buildInfo'
import { type Translate, useLocale, useT } from '../lib/i18n'
import { useUpdateStatus } from '../lib/updateStatus'
import { LocalServerRow } from './LocalServerRow'
import { Button } from './ui/button'
import { CardDescription, CardHeader, CardRow, CardTitle, SettingsCard } from './ui/card'
import { StatusLabel } from './ui/status-label'

/** The repository the fork's images are built from, for the commit link. */
export const SOURCE_REPO_URL = 'https://github.com/BRYANN2K/diazo'

/** Settings → General → About: the build this instance runs, and for
 *  admins (and a local install's user) whether a newer one is out. */
export function AboutCard() {
  const info = useBuildInfo()
  const { data: session } = authClient.useSession()
  const status = useUpdateStatus(session?.user.id)
  if (!info) return null
  return <AboutCardView info={info} status={status} />
}

export function AboutCardView({ info, status }: { info: BuildInfo; status?: UpdateStatus | null }) {
  const t = useT()
  const { locale } = useLocale()
  return (
    <SettingsCard>
      <CardHeader>
        <CardTitle>{t('updates.aboutTitle')}</CardTitle>
        <CardDescription>{t('updates.aboutDescription')}</CardDescription>
      </CardHeader>
      <CardRow label={t('updates.versionRow')}>
        <span className="font-mono text-body text-ink">{info.version}</span>
      </CardRow>
      <CardRow label={t('updates.commitRow')}>
        {info.sha ? (
          <a
            href={`${SOURCE_REPO_URL}/commit/${info.sha}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-body text-brand hover:underline"
          >
            {shortSha(info.sha)}
          </a>
        ) : (
          <span className="text-body text-ink-faint">{t('updates.unknownCommit')}</span>
        )}
      </CardRow>
      <CardRow label={t('updates.builtRow')}>
        <span className="text-body text-ink-soft">
          {info.date
            ? new Date(info.date).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
            : t('updates.devBuild')}
        </span>
      </CardRow>
      {status && (
        <CardRow label={t('updates.updatesRow')}>
          <StatusLabel tone={status.state === 'current' ? 'done' : 'muted'} className="text-body">
            {statusLine(t, status)}
          </StatusLabel>
          {status.compareUrl && status.state !== 'current' && (
            <Button variant="link" size="inline" className="text-brand" asChild>
              <a href={status.compareUrl} target="_blank" rel="noreferrer">
                {t('updates.seeChanges')}
              </a>
            </Button>
          )}
        </CardRow>
      )}
      <LocalServerRow />
    </SettingsCard>
  )
}

/** One line saying where this build stands. */
export function statusLine(t: Translate, status: UpdateStatus): string {
  const vars = { repo: status.repo, branch: status.branch }
  switch (status.state) {
    case 'current':
      return t('updates.statusCurrent', vars)
    case 'behind':
      return t('updates.statusBehind', { ...vars, count: status.behindBy })
    case 'ahead':
      return t('updates.statusAhead', { ...vars, count: status.aheadBy })
    case 'diverged':
      return t('updates.statusDiverged', vars)
    case 'disabled':
      return status.install === 'desktop' ? t('updates.statusDisabledDesktop') : t('updates.statusDisabled')
    case 'unknown':
      return status.reason === 'no-build-sha'
        ? t('updates.statusNoSha')
        : status.reason === 'not-found'
          ? t('updates.statusNotFound')
          : status.reason === 'rate-limited'
            ? t('updates.statusRateLimited')
            : t('updates.statusUnreachable')
  }
}
