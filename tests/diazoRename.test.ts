import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'
import {
  canonicalAgentName,
  DEFAULT_ROLE_ID,
  mentionedRole,
  roleByAgentName,
  roleById,
  roleHandle,
  withoutMentions,
} from '../shared/agents.ts'
import { buildMcpServer } from '../server/mcp.ts'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveTask: () => {},
}))

/* The product was renamed from Doop to Diazo. What was stored, typed or
   scripted under the old name must keep working. */

describe('the resident agent after the rename', () => {
  const resident = roleById(DEFAULT_ROLE_ID)!

  it('is the Diazo Agent, suggested as @diazo, under the id cards store', () => {
    expect(resident.id).toBe('doop')
    expect(resident.name).toBe('Diazo')
    expect(roleHandle(resident)).toBe('diazo')
  })

  it('answers @diazo, and @doop as a hidden spelling', () => {
    expect(mentionedRole('@diazo make it bluer')?.id).toBe('doop')
    expect(mentionedRole('@Diazo make it bluer')?.id).toBe('doop')
    expect(mentionedRole('@doop make it bluer')?.id).toBe('doop')
    expect(withoutMentions('ask @diazo and @doop')).toBe('ask diazo and doop')
  })

  it('still owns rows stored under the old name', () => {
    expect(roleByAgentName('Doop')?.id).toBe('doop')
    expect(canonicalAgentName('Doop')).toBe('Diazo')
    expect(canonicalAgentName('doop')).toBe('Diazo')
    expect(canonicalAgentName('Diazo')).toBe('Diazo')
    expect(canonicalAgentName('Claude Code')).toBe('Claude Code')
    expect(canonicalAgentName(undefined)).toBeUndefined()
  })

  it('leaves the other roles their own handles', () => {
    expect(roleHandle(roleById('ux')!)).toBe('ux')
    expect(mentionedRole('@ux check the flow')?.id).toBe('ux')
  })
})

describe('get_guide after the rename', () => {
  it('serves the guide under diazo-instructions and the old doop-instructions', async () => {
    const server = buildMcpServer('Test Owner', 'test-owner-id')
    const client = new Client({ name: 'diazo-guide-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      expect(client.getInstructions()).toContain('topic: "diazo-instructions"')
      const texts: string[] = []
      for (const topic of ['diazo-instructions', 'doop-instructions']) {
        const result = (await client.callTool({ name: 'get_guide', arguments: { topic } })) as {
          content: { type: string; text?: string }[]
          isError?: boolean
        }
        expect(result.isError).toBeFalsy()
        texts.push(result.content[0]?.text ?? '')
      }
      expect(texts[0]).toContain('# Diazo Agent Guide')
      expect(texts[0]).toContain('(@diazo)')
      expect(texts[1]).toBe(texts[0])
    } finally {
      await client.close()
    }
  })
})
