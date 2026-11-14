import type { AgentRunRecord } from './agentRuns.ts'
import type { ActivityItem, Frame, FrameVersionInfo } from './types.ts'

/**
 * Run replay: what one resident run did on a canvas. Frame versions carry
 * the run whose write filed them (the state that write replaced), so a
 * frame's oldest row tagged with the run is the frame as it was BEFORE the
 * run, and the first later row filed by anyone else holds what the run
 * left — proof the frame was written over since. A frame the run touched
 * with no row of its own was created by the run.
 */
export interface RunFrameChange {
  frameId: string
  name: string
  /** false = deleted since */
  exists: boolean
  /** the run made this frame: rolling back removes it */
  created: boolean
  /** the version holding the frame as it was before the run */
  beforeVersionId?: string
  /** the version holding the run's result, once a later write replaced it;
   *  absent = the live frame is still the run's result */
  afterVersionId?: string
  /** someone (a person, another run) wrote over the run's result */
  editedSince: boolean
}

export interface RunTimeline {
  runId: string
  /** absent when the ledger row is gone or the run is still going */
  run?: AgentRunRecord
  /** the run's activity lines, oldest first */
  events: ActivityItem[]
  frames: RunFrameChange[]
}

export interface RollbackResult {
  /** each restored frame and the state the rollback replaced (the undo copy) */
  restored: { frame: Frame; replaced: Pick<Frame, 'html' | 'width' | 'height'> }[]
  /** frames the run created, as they were when the rollback removed them */
  deleted: Frame[]
}

/** What a rollback refuses without confirmation: frames written over since. */
export interface RollbackConflict {
  conflicts: Pick<RunFrameChange, 'frameId' | 'name'>[]
}

/** The change one run made to one frame, from that frame's version rows. */
export function frameChange(
  runId: string,
  frame: { id: string; name: string; exists: boolean },
  versions: readonly FrameVersionInfo[],
  runStartedAt?: number,
): RunFrameChange {
  const ordered = [...versions].sort((a, b) => a.savedAt - b.savedAt)
  const own = ordered.filter((v) => v.runId === runId)
  const before = own[0]
  /* the run's own writes happen after it starts; a state someone else filed
     later than the run's last own row (or than the run's start, for a frame
     it created) is a write over its result */
  const after = Math.max(runStartedAt ?? 0, own.at(-1)?.savedAt ?? 0)
  const later = ordered.find((v) => v.runId !== runId && v.savedAt >= after && (!before || v.savedAt > before.savedAt))
  return {
    frameId: frame.id,
    name: frame.name,
    exists: frame.exists,
    created: !before,
    ...(before ? { beforeVersionId: before.id } : {}),
    ...(later ? { afterVersionId: later.id } : {}),
    editedSince: !!later,
  }
}
