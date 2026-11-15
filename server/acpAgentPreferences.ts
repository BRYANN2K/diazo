import { eq } from 'drizzle-orm'
import { db } from './db/index.ts'
import { acpAgentPreferences } from './db/schema.ts'
import {
  ACP_AGENTS,
  isAcpAgent,
  isAcpEffort,
  normalizeAcpModel,
  type AcpAgent,
  type AcpAgentPreference,
} from '../shared/acpAgent.ts'

export type AcpPreferences = Record<AcpAgent, AcpAgentPreference>

const OFF: AcpAgentPreference = { enabled: false, model: 'default' }

/** Every ACP agent's preference for one person; no row is off. */
export async function getAcpPreferences(userId: string): Promise<AcpPreferences> {
  const rows = await db.select().from(acpAgentPreferences).where(eq(acpAgentPreferences.userId, userId))
  const prefs = Object.fromEntries(ACP_AGENTS.map((agent) => [agent, OFF])) as AcpPreferences
  for (const row of rows) {
    if (!isAcpAgent(row.agent)) continue
    prefs[row.agent] = {
      enabled: row.enabled,
      model: normalizeAcpModel(row.model),
      ...(isAcpEffort(row.agent, row.effort) ? { effort: row.effort } : {}),
    }
  }
  return prefs
}

export async function getAcpPreference(userId: string, agent: AcpAgent): Promise<AcpAgentPreference> {
  return (await getAcpPreferences(userId))[agent]
}

export async function saveAcpPreference(userId: string, agent: AcpAgent, preference: AcpAgentPreference) {
  const values = {
    enabled: preference.enabled,
    model: normalizeAcpModel(preference.model),
    effort: isAcpEffort(agent, preference.effort) ? preference.effort : null,
  }
  await db
    .insert(acpAgentPreferences)
    .values({ userId, agent, ...values })
    .onConflictDoUpdate({ target: [acpAgentPreferences.userId, acpAgentPreferences.agent], set: values })
}
