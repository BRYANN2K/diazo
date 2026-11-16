import { useEffect, useState } from 'react'
import { type Translate, useT } from '../lib/i18n'
import { canChooseServer } from '../lib/desktopServer'
import { type LocalServerStatus, canReadLocalServer, wantsServerChoice, watchLocalServer } from '../lib/localServer'
import { ServerModal } from './ServerSettings'
import { Button } from './ui/button'
import { CardRow } from './ui/card'
import { StatusLabel } from './ui/status-label'

/** Settings → General → About in the desktop app on a Mac: whether this
 *  Mac's server runs (src/lib/localServer.ts), and the way to the server
 *  settings, which the Local Server menu's "Use Another Server…" opens
 *  through `?server=choose`. Nothing outside such a shell. */
export function LocalServerRow() {
  const t = useT()
  const [status, setStatus] = useState<LocalServerStatus | null>(null)
  const [choosing, setChoosing] = useState(() => canChooseServer() && wantsServerChoice(location.search))

  useEffect(() => watchLocalServer(setStatus), [])

  const close = () => {
    setChoosing(false)
    if (wantsServerChoice(location.search)) {
      const url = new URL(location.href)
      url.searchParams.delete('server')
      history.replaceState(history.state, '', url)
    }
  }

  return (
    <>
      {canReadLocalServer() && status && (
        <CardRow label={t('updates.localServerRow')}>
          <StatusLabel tone={status.state === 'running' ? 'done' : 'muted'} className="text-body">
            {localServerLine(t, status)}
          </StatusLabel>
          {canChooseServer() && (
            <Button variant="link" size="inline" className="text-brand" onClick={() => setChoosing(true)}>
              {t('updates.changeServer')}
            </Button>
          )}
        </CardRow>
      )}
      {choosing && <ServerModal onClose={close} />}
    </>
  )
}

export function localServerLine(t: Translate, status: LocalServerStatus): string {
  const vars = { url: status.url }
  const line =
    status.state === 'running'
      ? t('updates.localRunning', vars)
      : status.state === 'starting'
        ? t('updates.localStarting', vars)
        : status.state === 'stopped'
          ? t('updates.localStopped')
          : t('updates.localNotInstalled')
  return status.inUse && status.state !== 'not-installed' ? `${line} · ${t('updates.localInUse')}` : line
}
