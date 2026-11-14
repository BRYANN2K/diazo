import { runnerKey, type RunnerPick } from './agentRunner.ts'

/**
 * Model duel: one brief sent to 2-3 model picks at once, each designing into
 * its own sibling frame, so the results can be compared side by side and
 * one kept. Every entry is an ordinary board card scoped to its frame, so
 * the runs are metered (agent_runs) and replayable like any other.
 */
export const DUEL_MIN = 2
export const DUEL_MAX = 3
export const DUEL_MAX_BRIEF = 4000

export interface DuelEntry {
  frameId: string
  cardId: string
  runner: RunnerPick
  /** what the entry reads as, e.g. "ChatGPT · gpt-5" */
  label: string
}

export interface ModelDuel {
  id: string
  canvasId: string
  brief: string
  createdBy: string
  createdAt: number
  entries: DuelEntry[]
  /** the frame kept; the others are archived */
  pickedFrameId?: string
  decidedAt?: number
}

/** Why a duel request cannot run, or undefined when it can. */
export function duelProblem(brief: string, picks: readonly RunnerPick[]): string | undefined {
  if (!brief.trim()) return 'the brief is empty'
  if (brief.length > DUEL_MAX_BRIEF) return `the brief is over ${DUEL_MAX_BRIEF} characters`
  if (picks.length < DUEL_MIN || picks.length > DUEL_MAX) return `a duel takes ${DUEL_MIN} to ${DUEL_MAX} models`
  /* one run claims every card that agrees on the pick: two equal picks
     would design both frames in one run, which is no duel */
  if (new Set(picks.map(runnerKey)).size !== picks.length) return 'each model in a duel must be different'
  return undefined
}

/** The letter an entry goes by: A, B, C. */
export function duelLetter(index: number): string {
  return String.fromCharCode(65 + index)
}

/** One entry as the comparison card shows it. */
export interface DuelEntryResult extends DuelEntry {
  status: 'queued' | 'running' | 'done' | 'failed'
  /** false = the frame was deleted */
  exists: boolean
  /** the anti-slop lint score of the frame, 0-100 */
  lintScore?: number
  /** the run that designed it (agent_runs) */
  runId?: string
  costUsd?: number
  costEstimated?: boolean
  durationMs?: number
}

export interface DuelView extends ModelDuel {
  results: DuelEntryResult[]
}
