import { eq } from 'drizzle-orm'
import { db } from './db/index.ts'
import { referenceLibrary } from './db/schema.ts'
import { canvasesFor } from './workspaces.ts'
import { store } from './store.ts'
import { getLibrary, libraryRole } from './libraries.ts'

/**
 * The reference library: the canvases a user marked "the design system lives
 * here" in Settings. The chat run searches only these canvases with
 * find_references, a plan's references must point inside them, and Go design
 * hands the approved frames to the design agent as its base.
 *
 * Per user, like repo_links: a plan is built from the ASKER's library — a
 * collaborator's references never read a library they cannot open, since
 * every stored id is checked against what the user can still reach.
 */

export const LIBRARY_MAX_CANVASES = 20

/** The stored canvas ids, in the order they were picked. No row = no library. */
export async function getLibraryCanvasIds(userId: string): Promise<string[]> {
  const [row] = await db.select().from(referenceLibrary).where(eq(referenceLibrary.userId, userId))
  return row?.canvasIds ?? []
}

export async function setLibraryCanvasIds(userId: string, canvasIds: string[]): Promise<void> {
  const row = { userId, canvasIds, updatedAt: Date.now() }
  await db.insert(referenceLibrary).values(row).onConflictDoUpdate({ target: referenceLibrary.userId, set: row })
}

/** The library as it can be shown or searched right now: stored order,
 *  reduced to the canvases the user can still open — a deleted canvas or a
 *  revoked share simply drops out of the list. */
export async function libraryFor(
  userId: string,
  workingOn?: string,
): Promise<{ id: string; name: string; frameCount: number }[]> {
  const ids = await getLibraryCanvasIds(userId)
  const reachableList = canvasesFor(userId)
  const reachable = new Map(reachableList.map((meta) => [meta.id, meta]))
  const picked = ids.flatMap((id) => {
    const meta = reachable.get(id)
    if (meta) return [{ id: meta.id, name: meta.name, frameCount: meta.frameCount }]
    /* a public library is read through the library gate, not canvas access */
    const canvas = store.getCanvas(id)
    return canvas && libraryRole(userId, canvas)
      ? [{ id: canvas.id, name: canvas.name, frameCount: canvas.frames.length }]
      : []
  })
  /* the design libraries of the workspace the work happens in come along
     without being picked */
  const workspaceId = workingOn ? store.getCanvas(workingOn)?.workspaceId : undefined
  if (workspaceId) {
    for (const meta of reachableList) {
      const canvas = store.getCanvas(meta.id)
      if (canvas?.workspaceId !== workspaceId || !getLibrary(meta.id) || picked.some((p) => p.id === meta.id)) continue
      picked.push({ id: meta.id, name: meta.name, frameCount: meta.frameCount })
    }
  }
  return picked
}
