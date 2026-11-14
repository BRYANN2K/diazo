import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import { RULE_PRESETS } from '../shared/libraryRules'

/**
 * Design libraries against the REAL server (see ./harness.ts): a library
 * row survives a restart and rides on the canvas as `library`.
 */

let server: Server
let owner: Client
let canvasId: string

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('lib-owner@test.dev', 'Owner')
  canvasId = (await (await owner.post('/api/canvases', { name: 'Design Library' })).json()).id
}, 70_000)

afterAll(() => server?.stop())

describe('libraries across a restart', () => {
  it('keeps a library and mirrors it on the canvas', async () => {
    server.stop({ keepData: true })
    await server.stopped
    const pg = new PGlite(path.join(server.dataDir, 'data', 'pg'))
    await pg.query(
      `insert into libraries (canvas_id, description, rules, taxonomy, visibility, rules_version, created_at, updated_at)
       values ($1, 'Mine', $2, $3, 'private', 3, 1, 1)`,
      [canvasId, JSON.stringify(RULE_PRESETS.sheets), JSON.stringify({ kinds: [], sources: [], categories: [] })],
    )
    await pg.close()
    server = await startServer({}, server.dataDir)
    const canvas = await (await owner.get(`/api/canvases/${canvasId}`)).json()
    expect(canvas.library).toMatchObject({ description: 'Mine', visibility: 'private', rulesVersion: 3, items: 0 })
  }, 90_000)
})
