import { nanoid } from 'nanoid'
import { and, eq } from 'drizzle-orm'
import { db } from './db/index.ts'
import { codeLinks } from './db/schema.ts'
import { store } from './store.ts'
import {
  codePathProblem,
  describeCodeLink,
  exportNameProblem,
  isCodeLinkKind,
  normalizeCodePath,
  type CodeLink,
  type CodeLinkInput,
  type CodeLinkKind,
  type CodeLinkSource,
} from '../shared/codeLinks.ts'

/* Component ↔ file mapping (shared/codeLinks.ts). Rows are canvas-level —
 * one per target — and live in Postgres only: the hot canvas path never
 * needs them, and every reader (Inspector, get_component, get_frame, the
 * handoff pack) is already async. */

/** A mapping that cannot be stored, with the reason to show the caller. */
export class CodeLinkError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

function toLink(row: typeof codeLinks.$inferSelect): CodeLink {
  const source = row.source as CodeLinkSource
  return {
    id: row.id,
    canvasId: row.canvasId,
    targetKind: row.targetKind as CodeLinkKind,
    targetId: row.targetId,
    path: row.path,
    exportName: row.exportName,
    source: source === 'suggested' || source === 'generated' ? source : 'manual',
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  }
}

/** Whether the target still exists on the canvas — a deleted frame or
 *  component keeps no mapping worth showing. */
export function targetExists(canvasId: string, kind: CodeLinkKind, targetId: string): boolean {
  const canvas = store.getCanvas(canvasId)
  if (!canvas) return false
  return kind === 'frame'
    ? canvas.frames.some((f) => f.id === targetId)
    : (canvas.components ?? []).some((c) => c.id === targetId)
}

/** Every live mapping on a canvas; rows of deleted targets are skipped. */
export async function listCodeLinks(canvasId: string): Promise<CodeLink[]> {
  const rows = await db.select().from(codeLinks).where(eq(codeLinks.canvasId, canvasId))
  return rows.map(toLink).filter((link) => targetExists(canvasId, link.targetKind, link.targetId))
}

export async function codeLinkFor(
  canvasId: string,
  kind: CodeLinkKind,
  targetId: string,
): Promise<CodeLink | undefined> {
  const [row] = await db
    .select()
    .from(codeLinks)
    .where(and(eq(codeLinks.canvasId, canvasId), eq(codeLinks.targetKind, kind), eq(codeLinks.targetId, targetId)))
  return row ? toLink(row) : undefined
}

/** Validate a mapping's shape; answers the cleaned path and export name. */
export function cleanCodeLinkInput(input: CodeLinkInput): { path: string; exportName: string | null } {
  if (!isCodeLinkKind(input.targetKind)) throw new CodeLinkError("targetKind must be 'component' or 'frame'")
  const pathProblem = codePathProblem(input.path)
  if (pathProblem) throw new CodeLinkError(pathProblem)
  const exportName = input.exportName?.trim() || null
  if (exportName) {
    const exportProblem = exportNameProblem(exportName)
    if (exportProblem) throw new CodeLinkError(exportProblem)
  }
  return { path: normalizeCodePath(input.path), exportName }
}

/** Create or replace the target's mapping. */
export async function putCodeLink(canvasId: string, input: CodeLinkInput, by: string): Promise<CodeLink> {
  const { path, exportName } = cleanCodeLinkInput(input)
  if (!targetExists(canvasId, input.targetKind, input.targetId))
    throw new CodeLinkError(`${input.targetKind} ${input.targetId} not found on this canvas`, 404)
  const now = Date.now()
  const row = {
    id: nanoid(),
    canvasId,
    targetKind: input.targetKind,
    targetId: input.targetId,
    path,
    exportName,
    source: input.source ?? 'manual',
    updatedBy: by.slice(0, 200),
    updatedAt: now,
  }
  const [saved] = await db
    .insert(codeLinks)
    .values(row)
    .onConflictDoUpdate({
      target: [codeLinks.canvasId, codeLinks.targetKind, codeLinks.targetId],
      set: { path, exportName, source: row.source, updatedBy: row.updatedBy, updatedAt: now },
    })
    .returning()
  return toLink(saved!)
}

export async function deleteCodeLink(canvasId: string, kind: CodeLinkKind, targetId: string): Promise<boolean> {
  const rows = await db
    .delete(codeLinks)
    .where(and(eq(codeLinks.canvasId, canvasId), eq(codeLinks.targetKind, kind), eq(codeLinks.targetId, targetId)))
    .returning({ id: codeLinks.id })
  return rows.length > 0
}

/** The target an agent names: a component by name or id, or a frame id. */
export function resolveCodeTarget(
  canvasId: string,
  ref: { component?: unknown; frame_id?: unknown },
): { kind: CodeLinkKind; id: string; name: string } {
  const canvas = store.getCanvas(canvasId)
  if (!canvas) throw new CodeLinkError('canvas not found', 404)
  const component = typeof ref.component === 'string' ? ref.component.trim() : ''
  const frameId = typeof ref.frame_id === 'string' ? ref.frame_id.trim() : ''
  if (!!component === !!frameId) throw new CodeLinkError('name exactly one target: component or frame_id')
  if (component) {
    const wanted = component.toLowerCase()
    const def = (canvas.components ?? []).find((c) => c.id === component || c.name.toLowerCase() === wanted)
    if (!def) throw new CodeLinkError(`no component “${component}” on this canvas`, 404)
    return { kind: 'component', id: def.id, name: def.name }
  }
  const frame = canvas.frames.find((f) => f.id === frameId)
  if (!frame) throw new CodeLinkError(`frame ${frameId} not found on this canvas`, 404)
  return { kind: 'frame', id: frame.id, name: frame.name }
}

/** set_code_link's shared body (MCP and resident): set, or clear with path null. */
export async function setCodeLinkTool(
  canvasId: string,
  input: Record<string, unknown>,
  by: string,
): Promise<{ ok: true; link: ReturnType<typeof describeCodeLink> | null; target: { kind: CodeLinkKind; id: string } }> {
  const target = resolveCodeTarget(canvasId, input)
  if (input.path === null || input.path === '') {
    await deleteCodeLink(canvasId, target.kind, target.id)
    return { ok: true, link: null, target: { kind: target.kind, id: target.id } }
  }
  if (typeof input.path !== 'string') throw new CodeLinkError('path is required (null clears the mapping)')
  const link = await putCodeLink(
    canvasId,
    {
      targetKind: target.kind,
      targetId: target.id,
      path: input.path,
      exportName: typeof input.export_name === 'string' ? input.export_name : null,
      source: 'manual',
    },
    by,
  )
  return { ok: true, link: describeCodeLink(link), target: { kind: target.kind, id: target.id } }
}

export const SET_CODE_LINK_DESCRIPTION =
  'Record where a component or a frame lives in the linked repo: a repo-relative file path plus the export name (Button, or default). Implementers read it in get_component, get_frame and the Stip handoff pack. It writes nothing to the repo. Pass path null to clear the mapping.'
