import type { BuildInfo } from '../../shared/buildInfo'
import { shortSha } from '../../shared/buildInfo'
import { useBuildInfo } from '../lib/buildInfo'
import { useLocale, useT } from '../lib/i18n'
import { CardDescription, CardHeader, CardRow, CardTitle, SettingsCard } from './ui/card'

/** The repository the fork's images are built from, for the commit link. */
export const SOURCE_REPO_URL = 'https://github.com/BRYANN2K/redoop'

/** Settings → General → About: the build this instance runs. */
export function AboutCard() {
  const info = useBuildInfo()
  if (!info) return null
  return <AboutCardView info={info} />
}

export function AboutCardView({ info, children }: { info: BuildInfo; children?: React.ReactNode }) {
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
      {children}
    </SettingsCard>
  )
}
