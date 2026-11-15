/** Brand icons for well-known agents; Diazo's own marks otherwise. The marks
 *  themselves come from the BrandMark registry and Logo.tsx — this only knows
 *  which agent name wears which. */

import { roleByAgentName } from '../../shared/agents'
import { BrandMark, type Brand } from './ui/brand-mark'
import { DiazoAgentMark, DiazoMark } from './Logo'

/** the brand an agent name reads as, or none for a Diazo agent */
export function agentBrandOf(name: string): Extract<Brand, 'claude' | 'openai' | 'cursor'> | undefined {
  const n = name.toLowerCase()
  if (n.includes('claude')) return 'claude'
  if (n.includes('codex') || n.includes('gpt')) return 'openai'
  if (n.includes('cursor')) return 'cursor'
  return undefined
}

/** whether a name is the built-in Diazo Agent: one of the resident roles,
 *  under its current name or a former one (a stored `Doop`) */
export function isDiazoAgent(name: string): boolean {
  return roleByAgentName(name.trim()) !== undefined
}

export function AgentIcon({
  name,
  size = 13,
  color,
  working = false,
}: {
  name: string
  size?: number
  color?: string
  /** the built-in agent is at work: its face animates */
  working?: boolean
}) {
  const brand = agentBrandOf(name)
  if (brand) return <BrandMark brand={brand} size={size} color={color} className="mr-px inline-block align-[-2px]" />
  /* The built-in agent wears its own face, the two Ds in a ringed disc; on a
     coloured pill (`color` given) it is the bare mark in that colour. Any
     other agent (an unknown MCP client) gets Diazo's mark in the text colour. */
  if (isDiazoAgent(name) && !color) {
    return <DiazoAgentMark size={size} working={working} className="mr-px inline-block align-[-2px]" />
  }
  return <DiazoMark size={size} color={color} />
}
