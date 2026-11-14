import { nanoid } from 'nanoid'
import { and, desc, eq } from 'drizzle-orm'
import { db } from './db/index.ts'
import { modelDuels } from './db/schema.ts'
import { store } from './store.ts'
import * as actions from './actions.ts'
import type { Actor } from '../shared/types.ts'
import { RUNNER_NAMES, isRunnerProvider, parseRunnerPick, type RunnerPick } from '../shared/agentRunner.ts'
import {
  duelLetter,
  duelProblem,
  type DuelEntry,
  type DuelEntryResult,
  type DuelView,
  type ModelDuel,
} from '../shared/duel.ts'
import * as persist from './db/persist.ts'
import { getRun } from './agentRuns.ts'
import { isCustomProviderKind } from '../shared/customProvider.ts'

/* Model duels (shared/duel.ts): one brief, 2-3 model picks, one empty
 * sibling frame and one scoped board card per pick. The cards run like any
 * other, so each entry's cost and time come from its run in agent_runs. */

/** The size each duel frame starts at: a desktop screen. */
export const DUEL_FRAME = { width: 1440, height: 900 }
const DUEL_GAP = 80

export class DuelInputError extends Error {}

export const duelDeps = {
  insert: async (row: typeof modelDuels.$inferInsert) => {
    await db.insert(modelDuels).values(row)
  },
  update: async (id: string, patch: Partial<typeof modelDuels.$inferInsert>) => {
    await db.update(modelDuels).set(patch).where(eq(modelDuels.id, id))
  },
  list: (canvasId: string) =>
    db.select().from(modelDuels).where(eq(modelDuels.canvasId, canvasId)).orderBy(desc(modelDuels.createdAt)).limit(20),
  frameRuns: (frameId: string) => persist.listFrameRunIds(frameId),
  run: (runId: string) => getRun(runId),
  get: (canvasId: string, id: string) =>
    db
      .select()
      .from(modelDuels)
      .where(and(eq(modelDuels.canvasId, canvasId), eq(modelDuels.id, id)))
      .limit(1),
}

/** "ChatGPT · gpt-5": the connection and the model the pick names. */
export function pickLabel(pick: RunnerPick): string {
  const name = isCustomProviderKind(pick.provider)
    ? 'Custom'
    : (RUNNER_NAMES[pick.provider as keyof typeof RUNNER_NAMES] ?? pick.provider)
  return pick.model ? `${name} · ${pick.model}` : name
}

/** Where a row of `count` new frames goes on `pageId`: right of everything
 *  already there, top-aligned with it. */
function placement(canvasId: string, pageId: string | undefined, count: number) {
  const onPage = (store.getCanvas(canvasId)?.frames ?? []).filter((f) => !pageId || f.pageId === pageId)
  const x = onPage.length ? Math.max(...onPage.map((f) => f.x + f.width)) + DUEL_GAP * 2 : 0
  const y = onPage.length ? Math.min(...onPage.map((f) => f.y)) : 0
  return Array.from({ length: count }, (_, i) => ({ x: x + i * (DUEL_FRAME.width + DUEL_GAP), y }))
}

function toDuel(row: typeof modelDuels.$inferSelect): ModelDuel {
  return {
    id: row.id,
    canvasId: row.canvasId,
    brief: row.brief,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    entries: Array.isArray(row.entries) ? (row.entries as DuelEntry[]) : [],
    ...(row.pickedFrameId ? { pickedFrameId: row.pickedFrameId } : {}),
    ...(row.decidedAt ? { decidedAt: row.decidedAt } : {}),
  }
}

/**
 * Start a duel: the frames land side by side, then one card per pick, each
 * scoped to its frame and carrying its pick. The allowance is the caller's
 * to meter, one task per entry.
 */
export async function startDuel(input: {
  canvasId: string
  pageId?: string
  brief: string
  picks: unknown
  actor: Actor
  userId: string
}): Promise<ModelDuel> {
  const picks = (Array.isArray(input.picks) ? input.picks : [])
    .map(parseRunnerPick)
    .filter((p): p is RunnerPick => !!p && isRunnerProvider(p.provider))
  const brief = input.brief.trim()
  const problem = duelProblem(brief, picks)
  if (problem) throw new DuelInputError(problem)
  const spots = placement(input.canvasId, input.pageId, picks.length)
  const entries: DuelEntry[] = []
  for (const [i, pick] of picks.entries()) {
    const label = pickLabel(pick)
    const frame = actions.createFrame(
      input.canvasId,
      {
        name: `Duel ${duelLetter(i)} · ${label}`,
        ...(input.pageId ? { pageId: input.pageId } : {}),
        ...spots[i]!,
        ...DUEL_FRAME,
      },
      input.actor,
    )
    if (!frame) throw new DuelInputError('the canvas is gone')
    const card = actions.addQueuedCard(
      input.canvasId,
      `${brief}\n\n(Model duel, entry ${duelLetter(i)}: design this in the empty frame you are scoped to. Other models answer the same brief in the frames beside it; do not touch them.)`,
      input.actor.name,
      ['doop'],
      [],
      input.userId,
      { frameId: frame.id },
      pick,
    )
    if (!card) throw new DuelInputError('the card could not be queued')
    entries.push({ frameId: frame.id, cardId: card.id, runner: pick, label })
  }
  const duel: ModelDuel = {
    id: nanoid(10),
    canvasId: input.canvasId,
    brief,
    createdBy: input.actor.name,
    createdAt: Date.now(),
    entries,
  }
  await duelDeps.insert({
    id: duel.id,
    canvasId: duel.canvasId,
    brief: duel.brief,
    createdBy: duel.createdBy,
    createdAt: duel.createdAt,
    entries: duel.entries,
  })
  return duel
}

/** Each entry as the comparison card shows it: where its card is, the
 *  frame's lint score, and the cost and time of the run that designed it. */
export async function duelView(duel: ModelDuel): Promise<DuelView> {
  const cards = actions.getTasks(duel.canvasId)
  const results: DuelEntryResult[] = []
  for (const entry of duel.entries) {
    const card = cards.find((c) => c.id === entry.cardId)
    const frame = store.getFrame(entry.frameId)
    const status: DuelEntryResult['status'] = !card
      ? 'done'
      : card.failedAt
        ? 'failed'
        : card.endedAt
          ? 'done'
          : card.agentName
            ? 'running'
            : 'queued'
    const [runId] = await duelDeps.frameRuns(entry.frameId)
    const run = runId ? await duelDeps.run(runId) : undefined
    results.push({
      ...entry,
      status,
      exists: !!frame,
      ...(frame?.lint ? { lintScore: frame.lint.score } : {}),
      ...(runId ? { runId } : {}),
      ...(run?.costUsd !== undefined ? { costUsd: run.costUsd } : {}),
      ...(run ? { costEstimated: run.costEstimated, durationMs: run.endedAt - run.startedAt } : {}),
    })
  }
  return { ...duel, results }
}

export async function listDuels(canvasId: string): Promise<DuelView[]> {
  return Promise.all((await duelDeps.list(canvasId)).map(toDuel).map(duelView))
}

export async function getDuel(canvasId: string, id: string): Promise<ModelDuel | undefined> {
  const [row] = await duelDeps.get(canvasId, id)
  return row ? toDuel(row) : undefined
}

/**
 * Keep one entry: the pick lands in Memory as a canvas decision (which
 * model, against which others, for which brief), and the other entries are
 * archived — hidden and renamed, never deleted, so their history and runs
 * stay inspectable.
 */
export async function pickDuel(
  canvasId: string,
  duelId: string,
  frameId: string,
  actor: Actor,
): Promise<DuelView | undefined> {
  const duel = await getDuel(canvasId, duelId)
  if (!duel) return undefined
  if (duel.pickedFrameId) throw new DuelInputError('this duel is already decided')
  const kept = duel.entries.find((e) => e.frameId === frameId)
  if (!kept || !store.getFrame(frameId)) throw new DuelInputError('that frame is not an entry of this duel')
  const others = duel.entries.filter((e) => e !== kept)
  actions.recordDuelDecision(
    canvasId,
    `Model duel “${duel.brief}”: kept ${kept.label} over ${others.map((e) => e.label).join(', ')}.`,
    frameId,
    actor,
  )
  for (const other of others) {
    const frame = store.getFrame(other.frameId)
    if (frame && !frame.hidden) actions.updateFrame(frame.id, { hidden: true, name: `${frame.name} (archived)` }, actor)
  }
  const decided: ModelDuel = { ...duel, pickedFrameId: frameId, decidedAt: Date.now() }
  await duelDeps.update(duel.id, { pickedFrameId: frameId, decidedAt: decided.decidedAt })
  return duelView(decided)
}
