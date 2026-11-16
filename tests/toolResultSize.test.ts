import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'

/* every write the edit path files — versions, tasks, activity, feedback */
vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  deleteCanvas: () => {},
  saveFrame: () => {},
  saveFrameVersion: () => {},
  saveFramePage: () => {},
  frameWritePending: () => {},
  saveActivity: () => {},
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveCommentNow: () => {},
  saveChatMessage: () => {},
  saveComposition: () => {},
  saveCompositionVersion: () => {},
  deleteComposition: () => {},
  deleteCompositions: () => {},
  saveGuideline: () => {},
  deleteGuideline: () => {},
  saveSkill: () => {},
  deleteSkill: () => {},
  saveToken: () => {},
  deleteToken: () => {},
  saveReference: () => {},
  deleteReference: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveMember: () => {},
  deleteMember: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
  saveRenderJob: () => {},
  deleteRenderJob: () => {},
  MAX_COMPOSITION_VERSIONS: 20,
}))

/* AC-4: write tools answer lean — the JSON payload of set_composition and the
   frame edit tools fits in 600 characters, before the findings and nudges that
   ride along as extra content blocks. */

const LIMIT = 600
const DOC = '<!DOCTYPE html><html><body><h1 id="t">Hi</h1></body></html>'

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function connect() {
  const server = buildMcpServer('Test Owner', 'owner-ac4')
  const client = new Client({ name: 'ac4-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  return {
    client,
    call: async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as unknown as CallResult
      const payload = result.content.find((block) => block.type === 'text')?.text ?? ''
      return { result, payload }
    },
    close: () => Promise.all([client.close(), server.close()]),
  }
}

const canvas = store.createCanvas('Result sizes', 'owner-ac4')
const actor = { name: 'AC4 Agent', kind: 'agent' as const, color: '#000' }
const frame = actions.createFrame(canvas.id, { name: 'Hero', html: DOC }, actor)!

afterAll(() => {
  store.deleteCanvas(canvas.id)
})

describe('lean write results (AC-4)', () => {
  it('set_frame_html answers a pointer, not a summary', async () => {
    const { call, close } = await connect()
    try {
      const { result, payload } = await call('set_frame_html', {
        frame_id: frame.id,
        html: '<!DOCTYPE html><html><body><h1 id="t">Changed</h1></body></html>',
        agent_name: 'AC4 Agent',
      })
      expect(result.isError).not.toBe(true)
      expect(JSON.parse(payload)).toMatchObject({ ok: true, frame: { id: frame.id } })
      expect(payload.length).toBeLessThanOrEqual(LIMIT)
    } finally {
      await close()
    }
  })

  it('edit_frame_html answers a pointer, and the review nudge is sent only once', async () => {
    const { call, close } = await connect()
    try {
      const first = await call('edit_frame_html', {
        frame_id: frame.id,
        old_str: '<h1 id="t">Changed</h1>',
        new_str: '<h1 id="t">Again</h1>',
        agent_name: 'AC4 Agent',
      })
      expect(first.result.isError).not.toBe(true)
      expect(first.payload.length).toBeLessThanOrEqual(LIMIT)
      const nudges = (texts: CallResult['content']) =>
        texts.filter((b) => b.type === 'text' && b.text?.includes('get_frame_screenshot')).length
      /* the first write result after this agent's create may or may not carry
         the nudge — but a second write never repeats it */
      const second = await call('edit_frame_html', {
        frame_id: frame.id,
        old_str: '<h1 id="t">Again</h1>',
        new_str: '<h1 id="t">Once</h1>',
        agent_name: 'AC4 Agent',
      })
      expect(nudges(second.result.content)).toBe(0)
      expect(second.payload.length).toBeLessThanOrEqual(LIMIT)
    } finally {
      await close()
    }
  })

  it('update_frame answers a pointer', async () => {
    const { call, close } = await connect()
    try {
      const { result, payload } = await call('update_frame', {
        frame_id: frame.id,
        name: 'Hero renamed',
        x: 120,
        agent_name: 'AC4 Agent',
      })
      expect(result.isError).not.toBe(true)
      expect(JSON.parse(payload)).toMatchObject({ ok: true, frame: { id: frame.id, name: 'Hero renamed' } })
      expect(payload.length).toBeLessThanOrEqual(LIMIT)
    } finally {
      await close()
    }
  })

  it('set_composition answers a revision, not the timeline', async () => {
    const { call, close } = await connect()
    try {
      const pageId = `${canvas.id}:page1`
      const { result, payload } = await call('set_composition', {
        canvas_id: canvas.id,
        page_id: pageId,
        composition: { duration: 10, fps: 30, width: 1920, height: 1080, tracks: [] },
        agent_name: 'AC4 Agent',
      })
      expect(result.isError).not.toBe(true)
      expect(JSON.parse(payload)).toEqual({ ok: true, revision: expect.any(Number) })
      expect(payload.length).toBeLessThanOrEqual(LIMIT)
    } finally {
      await close()
    }
  })
})
