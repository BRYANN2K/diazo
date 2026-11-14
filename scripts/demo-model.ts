/**
 * A scripted stand-in for the Anthropic Messages API, for the README demo
 * only (scripts/readme-shots.ts). The server reaches it through
 * ANTHROPIC_BASE_URL with a demo Claude key, so the real agent, curation,
 * usage and duel code runs end to end and nothing leaves the machine.
 *
 * It plays the parts the demo needs: a library curator (category tree and
 * filing, keyed off the prompts in server/libraryCuration.ts), a chat agent
 * that answers with one plan (propose_plan), and a designer that rewrites
 * the frame a scoped card or a duel entry points at (set_frame_html).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

type Block = { type: string; text?: string; content?: unknown }
type Message = { role: string; content: string | Block[] }
interface Request {
  model: string
  system?: string | { text: string }[]
  messages: Message[]
  tools?: { name: string }[]
}

type Reply = { text: string } | { tool: string; input: unknown; text?: string }

/** The tree the curator proposes, and the words that file an item under each leaf. */
const TREE: { name: string; children: { name: string; words: string[] }[] }[] = [
  {
    name: 'Components',
    children: [
      { name: 'Buttons', words: ['button', 'cta', 'link button'] },
      { name: 'Inputs', words: ['input', 'field', 'search', 'select', 'toggle', 'checkbox'] },
      { name: 'Cards', words: ['card', 'tile', 'stat'] },
      { name: 'Navigation', words: ['nav', 'tab', 'sidebar', 'breadcrumb', 'menu'] },
      { name: 'Badges', words: ['badge', 'tag', 'chip', 'avatar'] },
    ],
  },
  {
    name: 'Sections',
    children: [
      { name: 'Heroes', words: ['hero', 'headline'] },
      { name: 'Pricing', words: ['pricing', 'plan', 'tier'] },
      { name: 'Testimonials', words: ['testimonial', 'quote', 'review'] },
      { name: 'FAQ', words: ['faq', 'question'] },
      { name: 'Footers', words: ['footer'] },
    ],
  },
  {
    name: 'App screens',
    children: [
      { name: 'Dashboards', words: ['dashboard', 'overview', 'insights'] },
      { name: 'Onboarding', words: ['onboarding', 'welcome', 'sign in', 'sign up', 'login'] },
      { name: 'Settings', words: ['settings', 'profile', 'billing'] },
    ],
  },
]

function systemText(req: Request): string {
  if (typeof req.system === 'string') return req.system
  return (req.system ?? []).map((s) => s.text).join('\n')
}

function textOf(content: Message['content']): string {
  if (typeof content === 'string') return content
  return content.map((b) => (typeof b.text === 'string' ? b.text : '')).join('\n')
}

function hasToolResult(messages: Message[]): boolean {
  return messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'))
}

/** The tools the assistant already called in this conversation, in order. */
function toolsUsed(messages: Message[]): string[] {
  return messages.flatMap((m) =>
    m.role === 'assistant' && Array.isArray(m.content)
      ? m.content.flatMap((b) => (b.type === 'tool_use' ? [(b as { name?: string }).name ?? ''] : []))
      : [],
  )
}

/** "<id> <path>" lines of the classify prompt → the id of each leaf path. */
function categoryIds(system: string): Map<string, string> {
  const ids = new Map<string, string>()
  for (const line of system.split('\n')) {
    const m = /^(c\d+) (.+)$/.exec(line.trim())
    if (m) ids.set(m[2]!.trim().toLowerCase(), m[1]!)
  }
  return ids
}

function fileItems(system: string, user: string): string {
  const ids = categoryIds(system)
  const answer: Record<string, string> = {}
  for (const line of user.split('\n')) {
    const [n, label = '', , , text = ''] = line.split('|')
    if (!n) continue
    /* the name decides first, the visible text only when the name says nothing */
    const leafFor = (words: string) => {
      /* sections and screens before components: "Pricing toggle" is a pricing block */
      for (const top of [TREE[1]!, TREE[2]!, TREE[0]!]) {
        for (const leaf of top.children) {
          if (leaf.words.some((w) => words.includes(w))) return ids.get(`${top.name}/${leaf.name}`.toLowerCase())
        }
      }
      return undefined
    }
    answer[n.trim()] = leafFor(label.toLowerCase()) ?? leafFor(text.toLowerCase()) ?? 'none'
  }
  return JSON.stringify({ a: answer })
}

/** What a designer run writes into the frame it was scoped to. */
export type FrameWriter = (frameName: string, model: string) => string | null

function reply(req: Request, writeFrame: FrameWriter): Reply {
  const system = systemText(req)
  const first = req.messages[0]
  const user = first ? textOf(first.content) : ''
  if (system.includes('Propose ONE category tree')) {
    return {
      text: JSON.stringify({
        categories: TREE.map((t) => ({ name: t.name, children: t.children.map((c) => ({ name: c.name })) })),
      }),
    }
  }
  if (system.includes('You file items of a design library')) return { text: fileItems(system, user) }
  if (system.includes('NEW, empty design library')) {
    return {
      text: JSON.stringify({
        categories: TREE.slice(0, 2).map((t) => ({
          name: t.name,
          children: t.children.slice(0, 3).map((c) => ({ name: c.name })),
        })),
      }),
    }
  }
  const tools = new Set((req.tools ?? []).map((t) => t.name))
  const done = hasToolResult(req.messages)
  const all = req.messages.map((m) => textOf(m.content)).join('\n')
  if (tools.has('propose_plan') && !done) {
    return {
      tool: 'propose_plan',
      text: 'I read the canvas: the landing page, pricing and the dashboard share the Fieldnote tokens and the Button and Card components. Here is the onboarding plan.',
      input: {
        summary:
          'A three-step onboarding for new Fieldnote teams: name the workspace, invite the research team, and record the first interview.',
        screens: [
          {
            name: 'Onboarding — Workspace',
            width: 1440,
            height: 900,
            outline:
              'Split layout: form on the left (workspace name, team size), a preview of the notes board on the right.',
            reuse: ['--fn-green', '--fn-paper', 'Button', 'Card'],
          },
          {
            name: 'Onboarding — Invite',
            width: 1440,
            height: 900,
            outline: 'Email chips input, role select per person, a skip link. Same frame as step one.',
            reuse: ['Button', 'Input'],
          },
          {
            name: 'Onboarding — First interview',
            width: 1440,
            height: 900,
            outline: 'Upload or record, with the transcript preview and the tags Fieldnote suggests.',
            reuse: ['Card', 'Badge'],
          },
        ],
        open_questions: ['Do invited people get the Editor role by default, or Viewer?'],
      },
    }
  }
  const scoped = /Scoped to frame (\S+) \("([^"]+)"\)/.exec(all)
  const used = toolsUsed(req.messages)
  if (
    scoped &&
    used.includes('set_frame_html') &&
    !used.includes('screenshot_frame') &&
    tools.has('screenshot_frame')
  ) {
    return { tool: 'screenshot_frame', text: 'Checking the render.', input: { frame_id: scoped[1] } }
  }
  if (scoped && tools.has('set_frame_html') && !done) {
    const html = writeFrame(scoped[2]!, req.model)
    if (html) {
      return {
        tool: 'set_frame_html',
        text: 'Rewriting the frame with the Fieldnote tokens.',
        input: { frame_id: scoped[1], html },
      }
    }
  }
  if (done)
    return {
      text: 'Done. The frame uses the Fieldnote tokens, the Button component and a 44px tap target on every action.',
    }
  return { text: 'Noted.' }
}

function sse(model: string, r: Reply): string {
  const events: [string, unknown][] = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: `msg_${Math.random().toString(36).slice(2)}`,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 18_000 + Math.floor(Math.random() * 6000), output_tokens: 1 },
        },
      },
    ],
  ]
  let index = 0
  const text = 'tool' in r ? r.text : r.text
  if (text) {
    events.push(
      ['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } }],
      ['content_block_stop', { type: 'content_block_stop', index }],
    )
    index++
  }
  if ('tool' in r) {
    events.push(
      [
        'content_block_start',
        {
          type: 'content_block_start',
          index,
          content_block: {
            type: 'tool_use',
            id: `toolu_${Math.random().toString(36).slice(2)}`,
            name: r.tool,
            input: {},
          },
        },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(r.input) },
        },
      ],
      ['content_block_stop', { type: 'content_block_stop', index }],
    )
  }
  events.push(
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool' in r ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: 'tool' in r ? 2400 + Math.floor(Math.random() * 1600) : 120 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  )
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

/** Start the stand-in on a free local port; resolves with its base URL. */
export async function startDemoModel(writeFrame: FrameWriter): Promise<{ url: string; server: Server }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString()))
    req.on('end', () => {
      if (!req.url?.includes('/messages')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'demo model only' } }))
        return
      }
      const parsed = JSON.parse(body) as Request
      if (process.env.DEMO_MODEL_DEBUG) {
        const last = parsed.messages[parsed.messages.length - 1]
        console.error('[demo-model]', last ? JSON.stringify(last.content).slice(0, 1500) : '')
      }
      /* a little latency, so runs have a believable duration */
      setTimeout(
        () => {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end(sse(parsed.model, reply(parsed, writeFrame)))
        },
        600 + Math.random() * 900,
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }
}
