import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { expect, it, vi } from 'vitest'
import { buildMcpServer } from '../server/mcp.ts'
import { RESIDENT_TOOL_NAMES, TOOLS } from '../server/resident.ts'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveFrameNow: async () => {},
  saveTask: () => {},
  saveActivity: () => {},
  saveComposition: () => {},
  saveCompositionVersion: () => {},
  deleteComposition: () => {},
}))

/* The resident agents should be able to do whatever an agent connected over
   MCP can do on a canvas. Every MCP tool is either in the resident set under
   the same name, or listed here with the reason it is not: adding an MCP
   tool without deciding forces this test to fail. */

/** The resident agent does the same thing with differently shaped tools. */
const EQUIVALENT: Record<string, string[]> = {
  get_frame: ['get_frame_html', 'inspect_frame'],
  get_frame_screenshot: ['screenshot_frame'],
  get_component_preview: ['screenshot_component'],
  append_frame_html: ['begin_frame_rewrite', 'append_frame_rewrite', 'commit_frame_rewrite'],
}

/** Already in every resident run's prompt, or meaningless for an agent that lives on one canvas. */
const BY_CONTEXT = [
  'get_guide', // the system prompt carries the guide's sections
  'get_guidelines', // canvas guidelines ride as a system block
  'list_guidelines',
  'list_skills', // the skill list rides in the # Canvas skills system block
  'get_feedback', // feedback, cards and comments arrive in the kickoff
  'get_comments',
  'list_canvases', // a resident run is scoped to its canvas
  'create_canvas',
  'get_profile',
  'get_usage', // the harness meters a resident run itself; the ledger is for the humans and connected agents
]

/** Real gaps: MCP agents can do these and resident agents cannot yet. */
const MISSING = [
  'get_canvas',
  'delete_frame',
  'compare_with_url', // a drift review is queued as a drift card (Analyze the gaps); the resident's part is post_drift_finding
  'list_frame_versions',
  'restore_frame_version',
  'set_page_background',
  'export_frame',
  'upload_asset',
  'upload_font', // a resident run has no file to send: people add fonts in Settings → Fonts
  'create_live_frame',
  'list_linear_issues', // integration tools, registered by their connections
  'get_linear_issue',
  'get_handoff', // a dev task's brief serves the Orca coding agent it was launched for
  'update_dev_task', // only the Orca coding agent reports on its own task; a resident has none
  'export_frame_code', // frame → code is written through the UI's diff preview and the desktop dialog
  'suggest_code_links', // a resident run with a linked project searches it itself with repo_search
]

async function mcpTools() {
  const server = buildMcpServer('Test Owner', 'test-owner-id')
  const client = new Client({ name: 'parity-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  const { tools } = await client.listTools()
  await client.close()
  await server.close()
  return tools
}

async function mcpToolNames(): Promise<string[]> {
  return (await mcpTools()).map((tool) => tool.name)
}

it('gives resident agents every MCP tool, or records why not', async () => {
  const resident = new Set(RESIDENT_TOOL_NAMES)
  const unaccounted = (await mcpToolNames()).filter(
    (name) => !resident.has(name) && !EQUIVALENT[name] && !BY_CONTEXT.includes(name) && !MISSING.includes(name),
  )
  expect(unaccounted).toEqual([])
})

it('keeps the exception lists honest', async () => {
  const mcp = new Set(await mcpToolNames())
  const resident = new Set(RESIDENT_TOOL_NAMES)
  for (const name of [...Object.keys(EQUIVALENT), ...BY_CONTEXT, ...MISSING]) {
    expect(mcp.has(name), `${name} is no longer an MCP tool`).toBe(true)
    expect(resident.has(name), `${name} is now a resident tool; drop it from the exceptions`).toBe(false)
  }
  for (const names of Object.values(EQUIVALENT)) for (const name of names) expect(resident.has(name)).toBe(true)
})

it('exposes check_scene candidate_stack on both surfaces', async () => {
  /* the read-only what-if input must reach the same code path from MCP and
     the resident dispatcher — a schema on one side only would silently drop
     the diagnostic for the other agent */
  const mcp = (await mcpTools()).find((tool) => tool.name === 'check_scene')
  const mcpProps = (mcp?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}
  expect(Object.keys(mcpProps)).toContain('candidate_stack')
  const resident = TOOLS.find((tool) => tool.name === 'check_scene')
  const resProps = (resident?.input_schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}
  expect(Object.keys(resProps)).toContain('candidate_stack')
})

it('routes an MCP check_scene candidate_stack call through execMotionPro', async () => {
  /* the whole wire path: zod schema → checkScene → the candidate section,
     on a canvas the connecting account owns */
  const actions = await import('../server/actions.ts')
  const { store } = await import('../server/store.ts')
  const { canvasPages } = await import('../shared/pages.ts')
  actions.wire(
    () => {},
    () => {},
  )
  const canvas = store.createCanvas('parity', 'test-owner-id')!
  const pageId = canvasPages(canvas)[0]!.id
  actions.setComposition(
    canvas.id,
    {
      duration: 4,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: 'cam', kind: 'camera', keyframes: [] }],
    },
    pageId,
    actions.resolveActor({ name: 'parity', kind: 'agent' }),
  )
  const server = buildMcpServer('Test Owner', 'test-owner-id')
  const client = new Client({ name: 'parity-wire', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  const result = await client.callTool({
    name: 'check_scene',
    arguments: {
      canvas_id: canvas.id,
      page_id: pageId,
      pixels: false,
      agent_name: 'parity-agent',
      candidate_stack: {
        track_id: 'cam',
        effects: [
          { id: 'a', fx: 'gaussin-blur', params: {} },
          { id: 'b', fx: 'gaussian-blur', params: { radius: 200 } },
        ],
      },
    },
  })
  await client.close()
  await server.close()
  expect(result.isError).toBeFalsy()
  const [first] = result.content as { type: string; text?: string }[]
  const payload = JSON.parse(first?.text ?? '{}') as {
    ok: boolean
    candidate: { ok: boolean; diagnostics: { kind: string; instance: string }[] }
  }
  expect(payload.ok).toBe(true)
  expect(payload.candidate.ok).toBe(false)
  expect(payload.candidate.diagnostics).toEqual([expect.objectContaining({ kind: 'unknown_fx', instance: 'a' })])
})

it('gives resident agents the prototype tools', () => {
  expect(RESIDENT_TOOL_NAMES).toEqual(expect.arrayContaining(['get_prototype', 'set_prototype_start']))
})

it('gives resident agents every speech tool', () => {
  expect(RESIDENT_TOOL_NAMES).toEqual(
    expect.arrayContaining([
      'list_speech_engines',
      'estimate_speech',
      'transcribe_clip',
      'generate_voiceover',
      'get_transcript',
      'list_voices',
    ]),
  )
})
