import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import { RULE_PRESETS } from '../shared/libraryRules'

/**
 * The library indexer against the REAL server: a library whose full run
 * was cut off (state `running`) is indexed at boot, and its items survive
 * the next restart.
 */

let server: Server
let owner: Client
let canvasId: string
const FRAMES = 300

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('lib-index@test.dev', 'Owner')
  canvasId = (await (await owner.post('/api/canvases', { name: 'Generated library' })).json()).id
  for (let i = 0; i < FRAMES; i++) {
    const res = await owner.post(`/api/canvases/${canvasId}/frames`, {
      name: `cp.gen-item-${i} — Generated ${i}`,
      x: (i % 20) * 900,
      y: Math.floor(i / 20) * 700,
      width: 800,
      height: 600,
      html: `<!doctype html><html><body><p>Generated item ${i}</p></body></html>`,
    })
    expect(res.status).toBe(200)
  }
}, 120_000)

afterAll(() => server?.stop())

async function restart() {
  server.stop({ keepData: true })
  await server.stopped
  server = await startServer({}, server.dataDir)
}

async function libraryOf() {
  return (await (await owner.get(`/api/canvases/${canvasId}`)).json()).library
}

describe('indexing across restarts', () => {
  it('indexes 300 frames at boot and keeps the items', async () => {
    server.stop({ keepData: true })
    await server.stopped
    const pg = new PGlite(path.join(server.dataDir, 'data', 'pg'))
    await pg.query(
      `insert into libraries (canvas_id, rules, taxonomy, visibility, index_state, rules_version, created_at, updated_at)
       values ($1, $2, $3, 'private', $4, 1, 1, 1)`,
      [
        canvasId,
        JSON.stringify(RULE_PRESETS.sheets),
        JSON.stringify({ kinds: [], sources: [], categories: [] }),
        JSON.stringify({ status: 'running', total: FRAMES, done: 0, rendered: 0, failed: 0, startedAt: 1 }),
      ],
    )
    await pg.close()
    server = await startServer({}, server.dataDir)
    const deadline = Date.now() + 60_000
    let library = await libraryOf()
    while (library?.index?.status !== 'done' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200))
      library = await libraryOf()
    }
    expect(library).toMatchObject({ items: FRAMES, variants: 0, index: { status: 'done', done: FRAMES } })
    await restart()
    expect(await libraryOf()).toMatchObject({ items: FRAMES, index: { status: 'done' } })
  }, 150_000)
})
