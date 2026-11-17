import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { expect, it } from 'vitest'
it('stores script audits and enforces per-canvas idempotency keys', async () => {
  const db = new PGlite()
  try {
    await db.exec(await readFile('server/db/migrations/0084_script_runs.sql', 'utf8'))
    await db.exec(
      `INSERT INTO script_runs (id, canvas_id, owner_id, idempotency_key, created_at, record) VALUES
       ('a','canvas','u','key',1,'{"outcome":"ok"}'),
       ('b','other','u','key',2,'{}'),
       ('c','canvas','u',NULL,3,'{}'),
       ('d','canvas','u',NULL,4,'{}')`,
    )
    await expect(
      db.exec(
        `INSERT INTO script_runs (id, canvas_id, idempotency_key, created_at, record) VALUES ('e','canvas','key',5,'{}')`,
      ),
    ).rejects.toThrow(/unique/)
    /* several NULL keys share a canvas — only real keys deduplicate */
    await db.exec(
      `INSERT INTO script_runs (id, canvas_id, idempotency_key, created_at, record) VALUES ('f','canvas',NULL,6,'{}')`,
    )
    const { rows } = await db.query(`SELECT record->>'outcome' AS outcome FROM script_runs WHERE id='a'`)
    expect(rows).toEqual([{ outcome: 'ok' }])
    /* undo payloads live in their own column, empty for a query run */
    const { rows: undo } = await db.query(`SELECT undo FROM script_runs WHERE id='a'`)
    expect(undo).toEqual([{ undo: null }])
  } finally {
    await db.close()
  }
}, 30_000)
