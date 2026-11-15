import { linkFor, localRepo, repoToolCall } from './localRepo.ts'
import { REPO_WRITE_TTL_MS } from '../shared/localRepo.ts'
import { summarizePatch, type PatchSummary } from '../shared/patch.ts'

/* The doop → repo write path shared by token sync and frame → code: a
 * unified patch (shared/patch.ts) the server checks for shape, then hands
 * to the requester's own desktop app, whose repo_apply_patch re-checks it
 * against the real folder and asks in a native dialog before writing. The
 * server never writes the repo and never sees the folder's path. */

export class RepoPatchError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

export interface RepoPatchResult {
  written: string[]
  repo: string
}

export function checkPatch(patch: string): PatchSummary {
  try {
    return summarizePatch(patch)
  } catch (e) {
    throw new RepoPatchError(e instanceof Error ? e.message : String(e))
  }
}

export async function applyRepoPatch(
  userId: string,
  canvasId: string,
  patch: string,
  reason: string,
): Promise<RepoPatchResult> {
  checkPatch(patch)
  const link = await linkFor(userId, canvasId)
  if (!link) throw new RepoPatchError('no linked project — link this canvas to a folder first', 409)
  const device = localRepo.deviceFor(userId)
  if (!device || !device.grants.has(link.id))
    throw new RepoPatchError("the linked project is unavailable — the Diazo desktop app holding it isn't online", 409)
  const result = await repoToolCall(
    userId,
    link,
    'apply_patch',
    { patch, reason: reason.slice(0, 300) },
    REPO_WRITE_TTL_MS,
  )
  if (!result.ok) {
    if (result.error === 'cancelled') throw new RepoPatchError('cancelled', 409)
    throw new RepoPatchError(result.error ?? 'the patch did not apply', 502)
  }
  const body = (result.result ?? {}) as Partial<RepoPatchResult>
  return { written: Array.isArray(body.written) ? body.written : [], repo: body.repo ?? link.name }
}
