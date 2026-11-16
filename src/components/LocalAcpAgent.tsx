import { useEffect, useState } from 'react'
import { authClient } from '../lib/auth'
import { isDesktopShell } from '../lib/shell'
import {
  disconnectAcpAgent,
  hasAcpAgent,
  invokeAcp,
  refreshAcpAgent,
  selectAcpAgent,
  stopAcpAgent,
  useAcpAgents,
  type AcpAgentState,
} from '../lib/acpAgent'
import { ACP_AGENT_NAMES, ACP_LOGIN_COMMANDS, acpMenu, type AcpAgent, type AcpEffort } from '../../shared/acpAgent'
import { useT } from '../lib/i18n'
import { effortOptions } from '../lib/effortLabels'
import { Button } from './ui/button'
import { AvailableRow, ConnectionRow, ModelSelect } from './ConnectionTable'
import { Disclosure } from './ui/collapsible'
import { AppIcon } from './ui/brand-mark'
import { cn } from '@/lib/utils'

/* a command inside the panel's prose */
const codeChip =
  'inline-block rounded-tag bg-surface px-[7px] py-px font-mono text-label text-ink shadow-ring [overflow-wrap:anywhere]'

const RUNNER = { devin: 'devin-local', grok: 'grok-local' } as const

/** Whether the pane lists this agent at all: the desktop shell runs it, or
 *  it is on for this account (a browser then shows it waiting for the desktop). */
export function acpAgentListed(agent: AcpAgent, state: AcpAgentState): boolean {
  return hasAcpAgent(agent) || !!state.preference?.enabled
}

/** Connected: on for the account, and this desktop may run it. */
export function acpAgentConnected(agent: AcpAgent, state: AcpAgentState): boolean {
  return isDesktopShell() && hasAcpAgent(agent) && !!state.preference?.enabled && !!state.native?.enabled
}

interface AcpRowProps {
  agent: AcpAgent
  isDefault?: boolean
  onMakeDefault?: () => void
  onChange?: () => void
}

/**
 * One desktop agent over ACP (Devin, Grok) in Settings → Doop Agent: under
 * "Add an agent" with Connect while the desktop shell can run it, then a
 * connected row with its model menu and effort, on/off and Disconnect, as
 * the Claude Plan's row does. Connect is the native consent dialog plus the
 * server's switch; the CLI's own sign-in stays in a terminal.
 */
export function AcpAgentRow({ agent, isDefault = false, onMakeDefault, onChange }: AcpRowProps) {
  const t = useT()
  const { data: session } = authClient.useSession()
  const userId = session?.user.id
  const state = useAcpAgents((s) => s[agent])
  const { preference, native, running, progress, error: runnerError } = state
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const name = ACP_AGENT_NAMES[agent]
  const supported = hasAcpAgent(agent)

  useEffect(() => {
    if (!userId) return
    const refresh = () => {
      refreshAcpAgent(userId, agent).catch((e: unknown) => setError(String(e)))
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [userId, agent])

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      onChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const active = preference?.enabled ?? false
  const connected = acpAgentConnected(agent, state)
  const model = preference?.model ?? 'default'
  const effort = preference?.effort
  /* the CLI's own list widens the curated menu, as the composer's does */
  const menu = acpMenu(agent, native?.models ?? [])

  const choose = (next: { model?: string; effort?: AcpEffort | undefined; enabled?: boolean } = {}) =>
    act(async () => {
      if (!userId) return
      const enabled = next.enabled ?? (connected ? active : true)
      if (enabled && !connected) {
        const { native: current } = await refreshAcpAgent(userId, agent, true)
        if (!current?.installed) throw new Error(t('models.acpInstallToConnect', { name }))
        if (!current.connected) throw new Error(t('models.acpSignInToConnect', { name }))
      }
      const nextEffort = 'effort' in next ? next.effort : effort
      await selectAcpAgent(userId, agent, {
        enabled,
        model: next.model ?? model,
        ...(nextEffort ? { effort: nextEffort } : {}),
      })
    })

  if (!acpAgentListed(agent, state)) return null

  const mark = <AppIcon brand={agent} />
  const short = t(agent === 'devin' ? 'models.acpDevinShort' : 'models.acpGrokShort')

  /* a browser, or a shell without this agent: nothing to run it with here */
  if (!isDesktopShell() || !supported) {
    return (
      <AvailableRow
        mark={mark}
        name={name}
        sub={active ? t('models.waitingDesktop') : t('models.desktopOnly')}
        panel={isDesktopShell() ? <p>{t('models.acpUpdateDoop', { name })}</p> : undefined}
        open={isDesktopShell()}
      />
    )
  }

  const signIn = (
    <p>
      {t('models.acpSignInBefore')}
      <code className={codeChip}>{native?.loginCommand ?? ACP_LOGIN_COMMANDS[agent]}</code>
      {t('models.acpSignInAfter')}
    </p>
  )
  const panel = (
    <div className="flex flex-col gap-[10px]">
      {native && !native.installed && <p>{t('models.acpNotFound', { name })}</p>}
      {native?.installed && native.cliPath && (
        <div className="flex flex-col gap-1.5">
          <span className="text-body font-medium text-ink">
            {native.cliVersion ? t('models.acpVersion', { name, version: native.cliVersion }) : name}
          </span>
          <code
            title={native.cliPath}
            className="block truncate rounded-control bg-sub px-3 py-2 font-mono text-label text-ink shadow-ring"
          >
            {native.cliPath}
          </code>
        </div>
      )}
      {native?.installed && !native.connected && signIn}
      {!connected && <p>{t('models.acpPermissions')}</p>}
      {active && !connected && <p>{t('models.waitingDesktop')}</p>}
      <div className="flex flex-wrap gap-2 empty:hidden max-md:[&>button]:flex-1">
        {native?.installed && !native.connected && (
          <Button
            disabled={busy}
            onClick={() =>
              act(async () => {
                await invokeAcp('acp_login', { agent })
                await refreshAcpAgent(userId!, agent, true)
              })
            }
          >
            {busy ? t('models.signingIn') : t('models.signIn')}
          </Button>
        )}
        {(!connected || (native && !native.connected)) && (
          <Button variant="ghost" disabled={busy} onClick={() => act(() => refreshAcpAgent(userId!, agent, true))}>
            {t('models.refresh')}
          </Button>
        )}
        {running && (
          <Button disabled={busy} onClick={() => act(() => stopAcpAgent(agent))}>
            {t('models.stopTask')}
          </Button>
        )}
      </div>
      {(running || runnerError) && (
        <Disclosure
          label={running ? t('models.working') : t('models.lastTaskFailed')}
          className="text-ink-soft"
          triggerClassName={cn(runnerError && 'text-accent-ink')}
        >
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-sans" aria-live="polite">
            {runnerError || progress}
          </pre>
        </Disclosure>
      )}
      {error && (
        <p role="alert" className="text-accent-ink">
          {error}
        </p>
      )}
    </div>
  )

  if (!connected) {
    return (
      <AvailableRow
        mark={mark}
        name={name}
        sub={short}
        action={
          <Button size="sm" disabled={busy} onClick={() => void choose({ enabled: true })}>
            {busy ? t('models.connecting') : t('models.connect')}
          </Button>
        }
        panel={panel}
        /* the error must show even when the shell answered nothing (native null) */
        open={!!error || !!(native && (!native.installed || !native.connected))}
      />
    )
  }

  const efforts = [
    { id: 'default', name: t('models.effortDefault'), blurb: t('models.acpEffortDefaultBlurb', { name }) },
    ...effortOptions(RUNNER[agent], menu.efforts, t),
  ]
  const showPanel = running || !!runnerError || !!error || !native?.connected
  return (
    <ConnectionRow
      mark={mark}
      name={name}
      sub={native?.cliVersion ? `${t('models.thisMac')} · ${native.cliVersion}` : t('models.thisMac')}
      state={active ? 'on' : 'off'}
      isDefault={isDefault}
      busy={busy || running}
      model={
        <ModelSelect
          name={name}
          models={menu.models}
          model={model}
          onModel={(id) => void choose({ model: id })}
          efforts={efforts}
          effort={effort ?? 'default'}
          onEffort={(id) => choose({ effort: id === 'default' ? undefined : (id as AcpEffort) })}
          disabled={busy || running}
        />
      }
      onToggle={(on) => void choose({ enabled: on })}
      {...(onMakeDefault ? { onMakeDefault } : {})}
      onDisconnect={() => void act(() => disconnectAcpAgent(userId!, agent))}
      panel={showPanel ? panel : undefined}
    />
  )
}
