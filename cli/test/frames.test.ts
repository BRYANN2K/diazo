import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hashHtml } from '../src/frames.ts'
import { main } from '../src/main.ts'
import { fakeIo, fakeServer, KEY, sandbox } from './helpers.ts'

let box: ReturnType<typeof sandbox>
afterEach(() => box?.cleanup())

/** A canvas with one frame, served through the fake MCP endpoint. */
function canvasServer(html = '<main>v1</main>') {
  const frame = {
    id: 'fr1',
    name: 'Home Page',
    html,
    updatedAt: '2026-11-14T10:00:00.000Z',
    updatedBy: 'Bryan',
    approvalStatus: 'draft',
  }
  const server = fakeServer({
    get_frame: (args) => {
      if (args.frame_id !== frame.id) throw new Error('unexpected frame')
      return { ...frame }
    },
    set_frame_html: (args) => {
      frame.html = String(args.html)
      return { ok: true }
    },
    find_in_canvas: () => ({
      total: 1,
      frames: 1,
      returned: 1,
      hits: [{ canvas_name: 'Lib', frame_id: 'fr1', frame_name: 'Home Page', page_name: 'Web', snippet: 'a [OTP] b' }],
    }),
  })
  return { frame, server }
}

function setup() {
  box = sandbox()
  box.writeUserConfig({ url: 'https://doop.test', agentKey: KEY })
  writeFileSync(path.join(box.cwd, '.doop.json'), JSON.stringify({ canvas: 'can1' }))
  return canvasServer()
}

async function run(argv: string[], server: ReturnType<typeof canvasServer>['server'], answers: boolean[] = []) {
  const io = fakeIo(answers)
  const code = await main(argv, { environment: box.environment(), io: io.io, fetch: server.fetch })
  return { code, ...io }
}

const link = () => JSON.parse(readFileSync(path.join(box.cwd, '.doop.json'), 'utf8')) as Record<string, unknown>
const pulled = (name = 'home-page.html') => path.join(box.cwd, name)

describe('doop find', () => {
  it('searches the linked canvas', async () => {
    const { server } = setup()
    const { code, out } = await run(['find', 'OTP', '-n', '5'], server)
    expect(code).toBe(0)
    expect(server.calls[0]).toMatchObject({
      name: 'find_in_canvas',
      args: { query: 'OTP', canvas_id: 'can1', limit: 5 },
    })
    expect(out.join('\n')).toContain('fr1  Home Page  (Web)')
  })

  it('searches every canvas with --all', async () => {
    const { server } = setup()
    await run(['find', 'OTP', '--all'], server)
    expect(server.calls[0]?.args).toEqual({ query: 'OTP' })
  })
})

describe('doop pull', () => {
  it('writes the frame to a file named after it and records the pull', async () => {
    const { server } = setup()
    expect((await run(['pull', 'https://doop.test/c/can1?frame=fr1'], server)).code).toBe(0)
    expect(readFileSync(pulled(), 'utf8')).toBe('<main>v1</main>')
    expect(link().frames).toEqual({ 'home-page.html': { frame: 'fr1', base: hashHtml('<main>v1</main>') } })
  })

  it('asks before overwriting a file with local edits', async () => {
    const { server } = setup()
    writeFileSync(pulled('mine.html'), 'local work')
    const { code, questions } = await run(['pull', 'fr1', '-o', 'mine.html'], server, [false])
    expect(code).toBe(1)
    expect(questions).toHaveLength(1)
    expect(readFileSync(pulled('mine.html'), 'utf8')).toBe('local work')
  })

  it('refreshes an untouched pulled file without asking', async () => {
    const { frame, server } = setup()
    await run(['pull', 'fr1'], server)
    frame.html = '<main>v2</main>'
    const { code, questions } = await run(['pull', 'fr1'], server)
    expect(code).toBe(0)
    expect(questions).toHaveLength(0)
    expect(readFileSync(pulled(), 'utf8')).toBe('<main>v2</main>')
  })
})

describe('doop push', () => {
  it('shows the change, asks, pushes and moves the base', async () => {
    const { frame, server } = setup()
    await run(['pull', 'fr1'], server)
    writeFileSync(pulled(), '<main>v1 edited</main>')
    const { code, out, questions } = await run(['push', 'home-page.html'], server, [true])
    expect(code).toBe(0)
    expect(questions).toEqual(['Push it?'])
    expect(out.join('\n')).toContain('+1 / -1 lines')
    expect(frame.html).toBe('<main>v1 edited</main>')
    expect(server.calls.find((c) => c.name === 'set_frame_html')?.args).toEqual({
      frame_id: 'fr1',
      html: '<main>v1 edited</main>',
      agent_name: 'doop CLI',
    })
    const frames = link().frames as Record<string, { base: string }>
    expect(frames['home-page.html']?.base).toBe(hashHtml('<main>v1 edited</main>'))
  })

  it('refuses when the frame changed on the canvas since the pull', async () => {
    const { frame, server } = setup()
    await run(['pull', 'fr1'], server)
    frame.html = '<main>edited in doop</main>'
    writeFileSync(pulled(), '<main>edited here</main>')
    const { code, err } = await run(['push', 'home-page.html', '-y'], server)
    expect(code).toBe(1)
    expect(err.join('\n')).toMatch(/changed on the canvas since your pull \(last edit by Bryan/)
    expect(frame.html).toBe('<main>edited in doop</main>')
    expect(server.calls.some((c) => c.name === 'set_frame_html')).toBe(false)
  })

  it('replaces a changed frame with --force', async () => {
    const { frame, server } = setup()
    await run(['pull', 'fr1'], server)
    frame.html = '<main>edited in doop</main>'
    writeFileSync(pulled(), '<main>edited here</main>')
    expect((await run(['push', 'home-page.html', '--force', '-y'], server)).code).toBe(0)
    expect(frame.html).toBe('<main>edited here</main>')
  })

  it('does nothing when declined or when nobody can answer', async () => {
    const { frame, server } = setup()
    await run(['pull', 'fr1'], server)
    writeFileSync(pulled(), '<main>x</main>')
    const { code, err } = await run(['push', 'home-page.html'], server, [false])
    expect(code).toBe(1)
    expect(err.join('\n')).toContain('--yes')
    expect(frame.html).toBe('<main>v1</main>')
  })

  it('needs --frame for a file it did not pull, and warns it cannot spot canvas edits', async () => {
    const { frame, server } = setup()
    writeFileSync(pulled('other.html'), '<p>new</p>')
    expect((await run(['push', 'other.html', '-y'], server)).code).toBe(1)
    const { code, err } = await run(['push', 'other.html', '-y', '--frame', 'fr1'], server)
    expect(code).toBe(0)
    expect(err.join('\n')).toContain('cannot be spotted')
    expect(frame.html).toBe('<p>new</p>')
  })

  it('refuses an empty file and says when nothing changed', async () => {
    const { server } = setup()
    await run(['pull', 'fr1'], server)
    expect((await run(['push', 'home-page.html'], server)).out.join('\n')).toContain('already matches')
    writeFileSync(pulled(), '  \n')
    expect((await run(['push', 'home-page.html', '-y'], server)).code).toBe(1)
    expect(existsSync(pulled())).toBe(true)
  })

  it('warns that a push withdraws an approval', async () => {
    const { frame, server } = setup()
    await run(['pull', 'fr1'], server)
    frame.approvalStatus = 'ready_for_dev'
    writeFileSync(pulled(), '<main>x</main>')
    const { out } = await run(['push', 'home-page.html', '-y'], server)
    expect(out.join('\n')).toContain('withdraws that approval')
  })
})
