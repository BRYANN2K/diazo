import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { expect, it } from 'vitest'
it('stores script audits and enforces per-canvas idempotency keys', async () => {
  const db = new PGlite()
  try {
    await db.exec(await readFile('server/db/migrations/0073_script_runs.sql', 'utf8'))
    await db.exec(
      `INSERT INTO script_runs VALUES ('a','canvas','key',1,'{"record":{"outcome":"ok"}}'); INSERT INTO script_runs VALUES ('b','other','key',2,'{}'); INSERT INTO script_runs VALUES ('c','canvas',NULL,3,'{}'),('d','canvas',NULL,4,'{}')`,
    )
    await expect(db.exec(`INSERT INTO script_runs VALUES ('e','canvas','key',5,'{}')`)).rejects.toThrow(/unique/)
    const { rows } = await db.query(`SELECT data->'record'->>'outcome' AS outcome FROM script_runs WHERE id='a'`)
    expect(rows).toEqual([{ outcome: 'ok' }])
  } finally {
    await db.close()
  }
}, 30_000)
