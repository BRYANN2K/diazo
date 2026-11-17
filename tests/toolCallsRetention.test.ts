import { afterAll, beforeEach, expect, it, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'

/* retention runs against the real schema — the prune SQL (window, per-canvas
   trim, NULL canvas_id) is the behaviour under test */
const holder = vi.hoisted(() => ({ client: undefined as unknown as PGlite }))
vi.mock('../server/db/index.ts', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const schema = await import('../server/db/schema.ts')
  holder.client = new PGlite()
  return { db: drizzle(holder.client, { schema }), initDb: async () => {} }
})
import { readFile } from 'node:fs/promises'
import { pruneToolCalls, TOOL_CALL_KEEP_DAYS, TOOL_CALL_KEEP_PER_CANVAS } from '../server/toolCalls.ts'

beforeEach(async () => {
  await holder.client.exec('DROP TABLE IF EXISTS tool_calls')
  await holder.client.exec(await readFile('server/db/migrations/0083_tool_calls.sql', 'utf8'))
})
afterAll(async () => {
  await holder.client.close()
})

const insert = (id: string, at: number, canvas: string | null = 'c1') =>
  `INSERT INTO tool_calls (id, canvas_id, source, tool, actor_name, actor_kind, input_bytes, result_bytes, image_pixels, ms, failed, at)
   VALUES ('${id}', ${canvas === null ? 'NULL' : `'${canvas}'`}, 'mcp', 't', 'a', 'agent', 1, 1, 0, 1, false, ${at})`

it('drops rows older than the keep window', async () => {
  const now = Date.now()
  await holder.client.exec(insert('old', now - (TOOL_CALL_KEEP_DAYS + 1) * 86_400_000))
  await holder.client.exec(insert('fresh', now - 1_000))
  expect(await pruneToolCalls(now)).toBe(1)
  const { rows } = await holder.client.query<{ id: string }>('SELECT id FROM tool_calls')
  expect(rows.map((r) => r.id)).toEqual(['fresh'])
})

it('trims each canvas to its most recent keep count, including null canvas', async () => {
  const now = Date.now()
  await holder.client.exec(
    `INSERT INTO tool_calls (id, canvas_id, source, tool, actor_name, actor_kind, input_bytes, result_bytes, image_pixels, ms, failed, at)
     SELECT 'c2-' || i, 'c2', 'mcp', 't', 'a', 'agent', 1, 1, 0, 1, false, ${now} - i
     FROM generate_series(0, ${TOOL_CALL_KEEP_PER_CANVAS + 2}) AS i`,
  )
  await holder.client.exec(insert('uncanvas', now))
  expect(await pruneToolCalls(now)).toBe(3)
  const { rows } = await holder.client.query<{ id: string; canvas_id: string | null; at: number }>(
    'SELECT id, canvas_id, at FROM tool_calls',
  )
  expect(rows.filter((r) => r.canvas_id === 'c2')).toHaveLength(TOOL_CALL_KEEP_PER_CANVAS)
  /* the newest rows are the ones kept */
  expect(rows.map((r) => r.id)).toContain('c2-0')
  expect(rows.map((r) => r.id)).not.toContain(`c2-${TOOL_CALL_KEEP_PER_CANVAS + 2}`)
  expect(rows.map((r) => r.id)).toContain('uncanvas')
})
