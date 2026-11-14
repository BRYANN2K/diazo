import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from '../../tests/harness.ts'
import { callTool } from '../src/client.ts'
import { main } from '../src/main.ts'
import { fakeIo, sandbox } from './helpers.ts'

/** The CLI against the real server: agent key on /mcp, find, pull, push and the stale-pull refusal. */

let server: Server
let secret: string
let canvasId: string
let frameId: string
let box: ReturnType<typeof sandbox>

beforeAll(async () => {
  server = await startServer()
  const owner = new Client(server)
  await owner.signUp('cli-owner@test.dev', 'Owner')
  secret = ((await (await owner.post('/api/agent-keys', { name: 'cli' })).json()) as { secret: string }).secret
  canvasId = ((await (await owner.post('/api/canvases', { name: 'CLI canvas' })).json()) as { id: string }).id
  const created = await callTool<{ frame?: { id: string }; id?: string }>(
    { url: server.base, key: secret },
    'create_frame',
    { canvas_id: canvasId, name: 'OTP screen', html: '<main><h1>Enter the OTP code</h1></main>', agent_name: 'test' },
  )
  frameId = created.frame?.id ?? created.id ?? ''
}, 70_000)

afterAll(() => server?.stop())
afterEach(() => box?.cleanup())

function cli(argv: string[], answers: boolean[] = []) {
  const io = fakeIo(answers)
  return main(argv, {
    environment: box.environment({ DOOP_URL: server.base, DOOP_AGENT_KEY: secret }),
    io: io.io,
  }).then((code) => ({ code, ...io }))
}

describe('doop CLI against the server', () => {
  it('links, finds, pulls, pushes and refuses a stale push', async () => {
    expect(frameId).not.toBe('')
    box = sandbox()
    expect((await cli(['link', canvasId])).code).toBe(0)

    const found = await cli(['find', 'OTP'])
    expect(found.code).toBe(0)
    expect(found.out.join('\n')).toContain(frameId)

    expect((await cli(['pull', frameId, '-o', 'otp.html'])).code).toBe(0)
    const file = path.join(box.cwd, 'otp.html')
    const pulled = readFileSync(file, 'utf8')
    expect(pulled).toContain('Enter the OTP code')

    writeFileSync(file, pulled.replace('Enter the OTP code', 'Type your code'))
    expect((await cli(['push', 'otp.html', '-y'])).code).toBe(0)
    const live = await callTool<{ html: string }>({ url: server.base, key: secret }, 'get_frame', { frame_id: frameId })
    expect(live.html).toContain('Type your code')

    await callTool({ url: server.base, key: secret }, 'set_frame_html', {
      frame_id: frameId,
      html: '<main><h1>Edited on the canvas</h1></main>',
      agent_name: 'test',
    })
    writeFileSync(file, '<main><h1>Local edit</h1></main>')
    const stale = await cli(['push', 'otp.html', '-y'])
    expect(stale.code).toBe(1)
    expect(stale.err.join('\n')).toContain('changed on the canvas since your pull')
  })

  it('reports a revoked or unknown key', async () => {
    box = sandbox()
    const io = fakeIo()
    const env = box.environment({ DOOP_URL: server.base, DOOP_AGENT_KEY: 'dpk_unknownunknownunknownunknown' })
    expect(await main(['find', 'x', '--all'], { environment: env, io: io.io })).toBe(1)
    expect(io.err.join('\n')).toContain('refused the agent key')
  })
})
