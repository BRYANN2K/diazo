import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { expect, it } from 'vitest'

/**
 * A task launched before the brief existed stored the change pack
 * (changeId, files) in `handoff`; get_handoff reads `brief.frames` and
 * would TypeError on it. 0082 folds those rows into an empty-frames
 * brief — and a row already in brief shape is left alone.
 */
it('rewrites a pre-brief handoff pack into an empty-frames brief', async () => {
  const db = new PGlite()
  try {
    await db.exec(`CREATE TABLE "frame_dev_tasks" (
      "id" text PRIMARY KEY NOT NULL,
      "canvas_id" text NOT NULL,
      "handoff" jsonb NOT NULL,
      "handoff_change_id" text NOT NULL
    )`)
    await db.query(
      `INSERT INTO "frame_dev_tasks" ("id", "canvas_id", "handoff", "handoff_change_id")
       VALUES ($1, $2, $3::jsonb, $4)`,
      [
        'old-task',
        'canvas-1',
        JSON.stringify({
          changeId: 'ch-1',
          dir: '.workflow/changes/ch-1',
          title: 'Old pack',
          proposal: 'p',
          spec: 's',
          tasks: 't',
          files: [{ path: 'proposal.md', base64: 'AAAA' }],
          draftedBy: 'agent',
          warnings: [],
        }),
        'ch-1',
      ],
    )
    await db.query(
      `INSERT INTO "frame_dev_tasks" ("id", "canvas_id", "handoff", "handoff_change_id")
       VALUES ($1, $2, $3::jsonb, $4)`,
      [
        'new-task',
        'canvas-1',
        JSON.stringify({ title: 'New brief', canvasId: 'canvas-1', frames: [{ id: 'f1' }], warnings: [] }),
        'ch-2',
      ],
    )

    await db.exec(await readFile('server/db/migrations/0082_drop_handoff_change_id.sql', 'utf8'))

    const { rows } = await db.query<{ id: string; pack: string }>(
      'SELECT "id", "handoff"::text AS pack FROM "frame_dev_tasks" ORDER BY "id"',
    )
    const byId = Object.fromEntries(rows.map((r) => [r.id, JSON.parse(r.pack)]))
    /* the old pack becomes the brief get_handoff serves: title kept, the
       row's canvas as canvasId, no frames, and a warning that says why */
    expect(byId['new-task']).toEqual({
      title: 'New brief',
      canvasId: 'canvas-1',
      frames: [{ id: 'f1' }],
      warnings: [],
    })
    expect(byId['old-task']).toEqual({
      title: 'Old pack',
      canvasId: 'canvas-1',
      frames: [],
      warnings: ['Launched before briefs: send the frame again.'],
    })
    const cols = await db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'frame_dev_tasks'",
    )
    expect(cols.rows.map((c) => c.column_name)).not.toContain('handoff_change_id')
  } finally {
    await db.close()
  }
}, 30_000)
