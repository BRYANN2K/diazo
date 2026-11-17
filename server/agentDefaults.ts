/**
 * Which of a person's connections runs work nobody picked one for: an
 * @mention comment, feedback on an old task, an automation. The person marks
 * one in Settings (`agent_defaults`); a mark that names a connection they no
 * longer have, or switched off, is passed over, and so is no mark at all:
 * then the Claude Plan while it is on (it always won before there was a
 * mark), else the account connected first that is on, else a desktop
 * agent over ACP (Devin, Grok) that is on.
 */
import { eq } from 'drizzle-orm'
import { db } from './db/index.ts'
import { agentDefaults } from './db/schema.ts'
import { getAccounts, type ModelAccount } from './modelAccounts.ts'
import { getLocalAgentPreference } from './localAgentPreferences.ts'
import { getAcpPreferences, type AcpPreferences } from './acpAgentPreferences.ts'
import { isLocalRunner, isRunnerProvider, type RunnerProvider } from '../shared/agentRunner.ts'
import type { LocalAgentPreference } from '../shared/localAgent.ts'
import { ACP_AGENTS, ACP_RUNNER, type AcpRunnerProvider } from '../shared/acpAgent.ts'

export async function getStoredDefault(userId: string): Promise<RunnerProvider | undefined> {
  const [row] = await db.select().from(agentDefaults).where(eq(agentDefaults.userId, userId))
  return isRunnerProvider(row?.provider) ? row.provider : undefined
}

export async function setStoredDefault(userId: string, provider: RunnerProvider): Promise<void> {
  const row = { userId, provider, updatedAt: Date.now() }
  await db
    .insert(agentDefaults)
    .values(row)
    .onConflictDoUpdate({ target: agentDefaults.userId, set: { provider, updatedAt: row.updatedAt } })
}

/** The default among what is connected and on now (`accounts` oldest first). */
export function resolveDefault(
  stored: RunnerProvider | undefined,
  planOn: boolean,
  accounts: readonly ModelAccount[],
  acpOn: readonly AcpRunnerProvider[] = [],
): RunnerProvider | undefined {
  const on = accounts.filter((account) => account.enabled && isRunnerProvider(account.kind))
  if (stored === 'claude-local' && planOn) return stored
  if (stored && acpOn.some((provider) => provider === stored)) return stored
  if (stored && on.some((account) => account.kind === stored)) return stored
  if (planOn) return 'claude-local'
  const first = on[0]?.kind
  return isRunnerProvider(first) ? first : acpOn[0]
}

/** The ACP agents switched on, in menu order. */
export function acpProvidersOn(acp: AcpPreferences): AcpRunnerProvider[] {
  return ACP_AGENTS.filter((agent) => acp[agent].enabled).map((agent) => ACP_RUNNER[agent])
}

/** Everything one decision needs, read together. */
export interface Connections {
  plan: LocalAgentPreference
  /** the desktop agents over ACP; absent reads as all off */
  acp?: AcpPreferences
  accounts: ModelAccount[]
  default: RunnerProvider | undefined
}

export async function readConnections(userId: string): Promise<Connections> {
  const [plan, acp, accounts, stored] = await Promise.all([
    getLocalAgentPreference(userId),
    /* a table that cannot be read leaves the desktop agents off, never the rest */
    getAcpPreferences(userId).catch((err: unknown): AcpPreferences | undefined => {
      console.error('[doop-agent] could not read the desktop agent preferences', err)
      return undefined
    }),
    getAccounts(userId),
    /* an unreadable mark is no mark: the fallback order still runs the work */
    getStoredDefault(userId).catch((err: unknown) => {
      console.error('[doop-agent] could not read the default connection', err)
      return undefined
    }),
  ])
  return {
    plan,
    ...(acp ? { acp } : {}),
    accounts,
    default: resolveDefault(stored, plan.enabled, accounts, acp ? acpProvidersOn(acp) : []),
  }
}

/** The account a provider names, when it is connected and on. */
export function usableAccount(connections: Connections, provider: RunnerProvider | undefined): ModelAccount | null {
  if (!provider || isLocalRunner(provider)) return null
  return connections.accounts.find((account) => account.kind === provider && account.enabled) ?? null
}
