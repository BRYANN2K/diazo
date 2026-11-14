import { linkFor, localRepo, repoToolCall } from './localRepo.ts'
import { listCodeLinks } from './codeLinks.ts'
import { store } from './store.ts'
import { frameToCode, type FrameCodeOptions } from './frameToCode.ts'
import type { FrameCodePreview } from '../shared/frameCode.ts'
import { RepoPatchError, checkPatch } from './repoPatch.ts'
import { diffReplace } from '../shared/patch.ts'
import type { RepoReadResult } from '../shared/localRepo.ts'
import type { Frame } from '../shared/types.ts'

/* Frame → code as a reviewable patch: generate the component (frameToCode),
 * read whatever already sits at its paths in the linked repo, and diff — a
 * new file is created, an existing one replaced. The same function backs
 * the preview and the write, so the write can prove it sends what was
 * shown. */

export async function frameCodePatch(userId: string, frame: Frame, opts: FrameCodeOptions): Promise<FrameCodePreview> {
  const canvas = store.getCanvas(frame.canvasId)
  if (!canvas) throw new RepoPatchError('canvas not found', 404)
  const links = await listCodeLinks(frame.canvasId).catch(() => [])
  const code = frameToCode(canvas, frame, store.getTokens(frame.canvasId), links, opts)
  const link = await linkFor(userId, frame.canvasId)
  if (!link) throw new RepoPatchError('no linked project — link this canvas to a folder first', 409)
  const device = localRepo.deviceFor(userId)
  if (!device || !device.grants.has(link.id))
    throw new RepoPatchError("the linked project is unavailable — the doop desktop app holding it isn't online", 409)
  const read = await repoToolCall(userId, link, 'read', { paths: code.files.map((f) => f.path) })
  if (!read.ok) throw new RepoPatchError(read.error ?? 'the repo read failed', 502)
  const existing = new Map<string, string | null>()
  for (const f of (read.result as RepoReadResult).files) {
    if (typeof f.text === 'string') existing.set(f.path, f.text)
    else if (f.error === 'missing') existing.set(f.path, null)
    else throw new RepoPatchError(`${f.path}: ${f.error ?? 'unreadable'} — pick another path`, 409)
  }
  const patch = code.files
    .map((f) => {
      const before = existing.has(f.path) ? existing.get(f.path)! : null
      return before === f.text ? '' : diffReplace(f.path, before, f.text)
    })
    .join('')
  return { code, patch, summary: patch ? checkPatch(patch) : null, repo: link.name }
}
