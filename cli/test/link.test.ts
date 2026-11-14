import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { main } from '../src/main.ts'
import { fakeIo, fakeServer, KEY, sandbox } from './helpers.ts'

let box: ReturnType<typeof sandbox>
afterEach(() => box?.cleanup())

const readLink = () => JSON.parse(readFileSync(path.join(box.cwd, '.doop.json'), 'utf8')) as Record<string, unknown>

describe('doop link', () => {
  it('checks the canvas and writes .doop.json', async () => {
    box = sandbox()
    box.writeUserConfig({ url: 'https://doop.test', agentKey: KEY })
    const server = fakeServer({ list_canvases: () => [{ id: 'can1', name: 'Design Library' }] })
    const { io, out } = fakeIo()
    const code = await main(['link', 'https://doop.test/c/can1?frame=f'], {
      environment: box.environment(),
      io,
      fetch: server.fetch,
    })
    expect(code).toBe(0)
    expect(readLink()).toEqual({ canvas: 'can1' })
    expect(out.join('\n')).toContain('Design Library')
  })

  it('refuses a canvas the key cannot open', async () => {
    box = sandbox()
    box.writeUserConfig({ url: 'https://doop.test', agentKey: KEY })
    const server = fakeServer({ list_canvases: () => [] })
    const { io, err } = fakeIo()
    expect(await main(['link', 'nope'], { environment: box.environment(), io, fetch: server.fetch })).toBe(1)
    expect(err.join('\n')).toContain('not one this agent key can open')
  })

  it('writes without checking when nothing is configured', async () => {
    box = sandbox()
    const { io, err } = fakeIo()
    expect(await main(['link', 'can1'], { environment: box.environment(), io })).toBe(0)
    expect(readLink()).toEqual({ canvas: 'can1' })
    expect(err.join('\n')).toContain('not checked')
  })

  it('asks before relinking and drops the old pulls', async () => {
    box = sandbox()
    writeFileSync(
      path.join(box.cwd, '.doop.json'),
      JSON.stringify({ canvas: 'old', url: 'https://doop.test', frames: { 'a.html': { frame: 'f' } } }),
    )
    const declined = fakeIo([false])
    expect(await main(['link', 'new'], { environment: box.environment(), io: declined.io })).toBe(1)
    expect(readLink().canvas).toBe('old')
    const accepted = fakeIo([true])
    expect(await main(['link', 'new'], { environment: box.environment(), io: accepted.io })).toBe(0)
    expect(readLink()).toEqual({ canvas: 'new', url: 'https://doop.test' })
  })
})

describe('doop open', () => {
  it('opens the linked canvas, or one frame of it', async () => {
    box = sandbox()
    writeFileSync(path.join(box.cwd, '.doop.json'), JSON.stringify({ canvas: 'can1' }))
    const { io, opened } = fakeIo()
    const environment = box.environment({ DOOP_URL: 'https://doop.tailnet.test:8850' })
    expect(await main(['open'], { environment, io })).toBe(0)
    expect(await main(['open', 'fr2'], { environment, io })).toBe(0)
    expect(opened).toEqual(['https://doop.tailnet.test:8850/c/can1', 'https://doop.tailnet.test:8850/c/can1?frame=fr2'])
  })

  it('says how to link when the folder is not linked', async () => {
    box = sandbox()
    const { io, err } = fakeIo()
    expect(await main(['open'], { environment: box.environment({ DOOP_URL: 'https://d.test' }), io })).toBe(1)
    expect(err.join('\n')).toContain('doop link')
  })
})

describe('doop config', () => {
  it('names the key source but never prints the key', async () => {
    box = sandbox()
    const { io, out } = fakeIo()
    await main(['config'], { environment: box.environment({ DOOP_AGENT_KEY: KEY, DOOP_URL: 'https://d.test' }), io })
    const text = out.join('\n')
    expect(text).toContain('DOOP_AGENT_KEY')
    expect(text).not.toContain(KEY)
  })

  it('exits 2 on bad usage', async () => {
    box = sandbox()
    const { io } = fakeIo()
    expect(await main(['frobnicate'], { environment: box.environment(), io })).toBe(2)
  })
})
