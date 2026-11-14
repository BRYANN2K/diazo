import * as persist from './db/persist.ts'
import { store } from './store.ts'
import { getRun } from './agentRuns.ts'
import * as actions from './actions.ts'
import type { Actor } from '../shared/types.ts'
import { frameChange, type RollbackResult, type RunFrameChange, type RunTimeline } from '../shared/runReplay.ts'

/* Run replay (shared/runReplay.ts): rebuild what one resident run did from
 * the rows it tagged — its activity lines and the frame versions its writes
 * filed — plus the frames its activity names (a frame it created files no
 * version of its own). */

export const replayDeps = {
  activity: (runId: string) => persist.listRunActivity(runId),
  versionedFrames: (runId: string) => persist.listRunFrameIds(runId),
  versions: (frameId: string) => persist.listFrameVersions(frameId),
  run: (runId: string) => getRun(runId),
}

/** The run's timeline on `canvasId`, or undefined when the run left nothing
 *  on that canvas (an unknown id, or another canvas's run). */
export async function runTimeline(canvasId: string, runId: string): Promise<RunTimeline | undefined> {
  const [run, events, versioned] = await Promise.all([
    replayDeps.run(runId),
    replayDeps.activity(runId),
    replayDeps.versionedFrames(runId),
  ])
  if (run && run.canvasId !== canvasId) return undefined
  const ownEvents = events.filter((e) => e.canvasId === canvasId).map(({ canvasId: _c, ...item }) => item)
  const frameIds = [...new Set([...versioned.map((v) => v.frameId), ...ownEvents.flatMap((e) => e.frameId ?? [])])]
  const names = new Map(ownEvents.filter((e) => e.frameId).map((e) => [e.frameId!, frameNameIn(e.message)]))
  const frames = []
  for (const frameId of frameIds) {
    const live = store.getFrame(frameId)
    const versionRow = versioned.find((v) => v.frameId === frameId)
    /* a frame of another canvas never shows up in this canvas's replay */
    if (live ? live.canvasId !== canvasId : versionRow && versionRow.canvasId !== canvasId) continue
    const versions = await replayDeps.versions(frameId)
    frames.push(
      frameChange(
        runId,
        { id: frameId, name: live?.name ?? names.get(frameId) ?? frameId, exists: !!live },
        versions,
        run?.startedAt,
      ),
    )
  }
  if (!run && ownEvents.length === 0 && frames.length === 0) return undefined
  return { runId, ...(run ? { run } : {}), events: ownEvents, frames }
}

/** `created frame “Hero”` → Hero: the name a deleted frame last had. */
function frameNameIn(message: string): string | undefined {
  return /“([^”]+)”/.exec(message)?.[1]
}

/** A rollback that would overwrite work done since the run. */
export class RollbackConflictError extends Error {
  constructor(readonly frames: RunFrameChange[]) {
    super('frames were edited since the run')
  }
}

/**
 * Undo a whole run: every frame it changed goes back to its state before
 * the run, every frame it created is removed. Each restore files the state
 * it replaces as a version, so the rollback is itself in the history. A
 * frame written over since the run is refused unless `force`, all or
 * nothing: the run comes back whole or not at all.
 */
export async function rollbackRun(
  canvasId: string,
  runId: string,
  actor: Actor,
  { force = false }: { force?: boolean } = {},
): Promise<RollbackResult | undefined> {
  const timeline = await runTimeline(canvasId, runId)
  if (!timeline) return undefined
  const targets = timeline.frames.filter((f) => f.exists && (f.created || f.beforeVersionId))
  const conflicts = targets.filter((f) => f.editedSince)
  if (conflicts.length > 0 && !force) throw new RollbackConflictError(conflicts)
  const result: RollbackResult = { restored: [], deleted: [] }
  for (const change of targets) {
    if (change.created) {
      const frame = actions.deleteFrame(change.frameId, actor)
      if (frame) result.deleted.push(frame)
    } else if (change.beforeVersionId) {
      const restored = await actions.restoreFrameVersion(change.frameId, change.beforeVersionId, actor)
      if (restored) result.restored.push(restored)
    }
  }
  return result
}
