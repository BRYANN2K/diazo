import type { DevTask, DevTaskState } from '../../shared/devTasks'
import type { MessageKey } from './i18n'
import { api } from './api'
import { useStore } from './store'

/**
 * Client side of the dev-task lifecycle (docs/orca.md): the open canvas's
 * `frame_dev_tasks` rows, hydrated from REST after every join and kept
 * current by the `dev-task` room broadcasts.
 */

/** Pull the canvas's task rows and merge them over whatever the room sent
 *  while the request was in flight. Called on every `init`, so a reconnect
 *  re-syncs rather than trusting what the socket already delivered. */
export async function hydrateDevTasks(canvasId: string): Promise<void> {
  try {
    const { tasks } = await api.canvasDevTasks(canvasId)
    useStore.getState().setDevTasks(tasks, canvasId)
  } catch {
    /* a guest on a link-shared canvas, or a dropped request, only loses the
       snapshot — broadcasts still carry every later change */
  }
}

/** The tasks a frame appears in, newest first. */
export function devTasksForFrame(devTasks: Record<string, DevTask>, frameId: string): DevTask[] {
  return Object.values(devTasks)
    .filter((task) => task.frameIds.includes(frameId))
    .sort((a, b) => b.createdAt - a.createdAt)
}

/** Any task touching the frame — a primitive for zustand selectors. */
export function hasDevTaskForFrame(devTasks: Record<string, DevTask>, frameId: string): boolean {
  for (const task of Object.values(devTasks)) if (task.frameIds.includes(frameId)) return true
  return false
}

/** The task a frame's title badge should follow: the newest launch. */
export function latestDevTaskForFrame(devTasks: Record<string, DevTask>, frameId: string): DevTask | undefined {
  return devTasksForFrame(devTasks, frameId)[0]
}

/** The i18n key a state reads as — one map so the badge, the Build card
 *  and tests share one spelling. */
export const DEV_TASK_STATE_KEYS = {
  queued: 'devTasks.stateQueued',
  starting: 'devTasks.stateStarting',
  working: 'devTasks.stateWorking',
  needs_input: 'devTasks.stateNeedsInput',
  pr_open: 'devTasks.statePrOpen',
  done: 'devTasks.stateDone',
  failed: 'devTasks.stateFailed',
  cancelled: 'devTasks.stateCancelled',
} satisfies Record<DevTaskState, MessageKey>
