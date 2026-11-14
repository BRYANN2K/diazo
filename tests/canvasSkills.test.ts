import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invokedSkills, skillSlug } from '../shared/skills.ts'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveTask: () => {},
  saveSkill: () => {},
  deleteSkill: () => {},
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { buildMcpServer } = await import('../server/mcp.ts')

const OWNER = 'skills-owner'
const person = () => actions.resolveActor({ name: 'Bryan', kind: 'user' })
let canvasId: string

beforeEach(() => {
  canvasId = store.createCanvas('skills', OWNER).id
})

describe('skill names', () => {
  it('slugs what a person types', () => {
    expect(skillSlug(' Pricing Page ')).toBe('pricing-page')
    expect(skillSlug('Hero/CTA')).toBe('hero-cta')
  })

  it('finds /name in an ask, once each, and not inside a path or a URL', () => {
    const skills = [{ name: 'pricing-page' }, { name: 'house-style' }]
    expect(invokedSkills('Do /pricing-page, then /house-style. And /pricing-page again', skills)).toEqual([
      'pricing-page',
      'house-style',
    ])
    expect(invokedSkills('see https://x.dev/pricing-page and a/house-style', skills)).toEqual([])
    expect(invokedSkills('/unknown please', skills)).toEqual([])
  })
})

describe('setSkill', () => {
  it('adds, updates and deletes a skill, keeping the description on an update', () => {
    const added = actions.setSkill(
      canvasId,
      { name: 'Pricing Page', description: 'When asked for a pricing page', markdown: '# Three tiers' },
      person(),
    )
    expect(added).toMatchObject({ name: 'pricing-page', description: 'When asked for a pricing page' })
    const updated = actions.setSkill(canvasId, { name: 'pricing-page', markdown: '# Two tiers' }, person())
    expect(updated).toMatchObject({ description: 'When asked for a pricing page', markdown: '# Two tiers' })
    expect(store.getSkills(canvasId)).toHaveLength(1)
    expect(actions.setSkill(canvasId, { name: 'pricing-page', markdown: '' }, person())).toBeNull()
    expect(store.getSkills(canvasId)).toEqual([])
  })

  it('refuses a new skill without a description, a bad name, and a missing canvas', () => {
    expect(() => actions.setSkill(canvasId, { name: 'x', markdown: 'body' }, person())).toThrow(/description/)
    expect(() => actions.setSkill(canvasId, { name: '!!', description: 'd', markdown: 'b' }, person())).toThrow(
      /invalid skill name/,
    )
    expect(actions.setSkill('nope', { name: 'x', description: 'd', markdown: 'b' }, person())).toBeUndefined()
  })

  it('briefs agents with the list, and the full text of the skills an ask names', () => {
    actions.setSkill(
      canvasId,
      { name: 'pricing-page', description: 'Pricing pages', markdown: 'THREE TIERS' },
      person(),
    )
    actions.setSkill(canvasId, { name: 'house-style', description: 'Any design', markdown: 'INTER ONLY' }, person())
    const plain = actions.skillsBrief(canvasId, 'Design a login')
    expect(plain).toContain('- house-style: Any design')
    expect(plain).not.toContain('INTER ONLY')
    const asked = actions.skillsBrief(canvasId, 'Design pricing with /pricing-page')
    expect(asked).toContain('## /pricing-page\n\nTHREE TIERS')
    expect(asked).not.toContain('INTER ONLY')
    expect(actions.skillsBrief(store.createCanvas('empty', OWNER).id, '/pricing-page')).toBe('')
  })
})

describe('MCP skill tools', () => {
  async function call(name: string, args: Record<string, unknown>) {
    const server = buildMcpServer('Test Owner', OWNER)
    const client = new Client({ name: 'skills-test', version: '1.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(b)
    await client.connect(a)
    try {
      return (await client.callTool({ name, arguments: args })) as {
        content: { type: string; text?: string }[]
        isError?: boolean
      }
    } finally {
      await client.close()
      await server.close()
    }
  }
  const textOf = (r: { content: { text?: string }[] }) => r.content.map((c) => c.text ?? '').join('\n')

  it('saves, lists, reads and deletes a skill', async () => {
    const saved = await call('set_skill', {
      canvas_id: canvasId,
      name: 'pricing-page',
      description: 'When asked for a pricing page',
      markdown: 'Three tiers, monthly toggle.',
      agent_name: 'Claude',
    })
    expect(saved.isError).toBeFalsy()
    expect(textOf(await call('list_skills', { canvas_id: canvasId }))).toContain('When asked for a pricing page')
    const read = textOf(await call('get_skill', { canvas_id: canvasId, name: '/pricing-page' }))
    expect(read).toContain('# /pricing-page')
    expect(read).toContain('Three tiers, monthly toggle.')
    const canvas = textOf(await call('get_canvas', { canvas_id: canvasId }))
    expect(canvas).toContain('"skills"')
    expect(canvas).toContain('call get_skill')
    await call('set_skill', { canvas_id: canvasId, name: 'pricing-page', markdown: '', agent_name: 'Claude' })
    const missing = await call('get_skill', { canvas_id: canvasId, name: 'pricing-page' })
    expect(missing.isError).toBe(true)
  })
})
