import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { drizzle as pgliteDrizzle } from 'drizzle-orm/pglite'
import { db } from '../server/db/index.ts'
import { store } from '../server/store.ts'
import * as persist from '../server/db/persist.ts'

/**
 * persist.flush: the drain that runs on shutdown. A frame write that fails
 * there must surface — logged per frame and rejecting the flush — not hide
 * inside Promise.allSettled behind a clean exit. Exercises the real
 * writeFrame path against a real (in-memory) PGlite.
 */
vi.mock('../server/db/index.ts', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const schema = await import('../server/db/schema.ts')
  return { db: drizzle(new PGlite(), { schema }) }
})

beforeAll(async () => {
  const { migrate } = await import('drizzle-orm/pglite/migrator')
  await migrate(db as unknown as ReturnType<typeof pgliteDrizzle>, { migrationsFolder: 'server/db/migrations' })
}, 30_000)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('persist.flush', () => {
  it('logs and propagates a failing frame write instead of settling quietly', async () => {
    const canvas = store.createCanvas('C', 'owner')
    const frame = store.createFrame(canvas.id, { name: 'F', html: '<p>x</p>' }, 'owner')!
    persist.saveFrame(frame)

    const boom = new Error('disk gone mid-flush')
    const insert = vi.spyOn(db, 'insert').mockImplementationOnce(() => {
      throw boom
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(persist.flush((id) => store.getFrame(id))).rejects.toThrow(/flush failed for 1 frame/)
    expect(error).toHaveBeenCalledWith(expect.stringContaining(`frame ${frame.id}`), boom)
    insert.mockRestore()

    /* the write stayed dirty, so the flush that follows persists it for
       real — a failed one is never dropped on the floor */
    await expect(persist.flush((id) => store.getFrame(id))).resolves.toBeUndefined()
  }, 30_000)
})
