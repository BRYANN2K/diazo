import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseDoopRef } from './args.ts'
import { lineDiff } from './diff.ts'
import { CommandError, type Session } from './session.ts'
import { projectKey, writeProjectFile, type Project } from './project.ts'

/** The name the CLI's edits are attributed to on the canvas. */
export const AGENT_NAME = 'doop CLI'

export interface FrameData {
  id: string
  name: string
  html: string
  updatedAt?: string
  updatedBy?: string
  approvalStatus?: string
}

interface FindHit {
  canvas_name: string
  frame_id: string
  frame_name: string
  page_name?: string
  snippet: string
}

interface FindResult {
  total: number
  frames: number
  returned: number
  hits: FindHit[]
}

export function hashHtml(html: string): string {
  return createHash('sha256').update(html).digest('hex')
}

/** `doop find <query>`: the find_in_canvas search over the linked canvas, or every canvas with --all. */
export async function find(session: Session): Promise<number> {
  const { flags, args } = session.invocation
  const result = await session.call<FindResult>('find_in_canvas', {
    query: args[0] ?? '',
    ...(flags.all ? {} : { canvas_id: session.canvas() }),
    ...(flags.matchCase ? { match_case: true } : {}),
    ...(flags.limit ? { limit: flags.limit } : {}),
  })
  const { io } = session.ctx
  for (const hit of result.hits) {
    const where = [flags.all ? hit.canvas_name : '', hit.page_name ?? ''].filter(Boolean).join(' / ')
    io.out(`${hit.frame_id}  ${hit.frame_name}${where ? `  (${where})` : ''}`)
    io.out(`    ${hit.snippet.replace(/\s+/g, ' ').trim()}`)
  }
  io.out(`${result.returned} of ${result.total} match(es) in ${result.frames} frame(s)`)
  return 0
}

function getFrame(session: Session, frameId: string): Promise<FrameData> {
  return session.call<FrameData>('get_frame', { frame_id: frameId })
}

function slug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/** The project key of a file, or '' when no `.doop.json` covers it. */
function keyFor(project: Project | null, file: string): string {
  if (!project) return ''
  try {
    return projectKey(project, file)
  } catch {
    return ''
  }
}

/** The pulled file already tracking a frame, if this project has one. */
function trackedFileFor(project: Project | null, frameId: string): string | undefined {
  const entry = Object.entries(project?.data.frames ?? {}).find(([, value]) => value.frame === frameId)
  return entry && project ? path.join(project.dir, entry[0]) : undefined
}

function recordPull(session: Session, file: string, frameId: string, html: string): boolean {
  const { project } = session
  const key = keyFor(project, file)
  if (!project || !key) return false
  project.data.frames = { ...project.data.frames, [key]: { frame: frameId, base: hashHtml(html) } }
  writeProjectFile(project.file, project.data)
  return true
}

/** `doop pull <frame>`: writes the frame's HTML to a file and remembers the version it came from. */
export async function pull(session: Session): Promise<number> {
  const { io, environment } = session.ctx
  const { flags, args } = session.invocation
  const { frame: frameId } = parseDoopRef(args[0] ?? '')
  if (!frameId) throw new CommandError('give a frame id or a link with ?frame=')
  const frame = await getFrame(session, frameId)
  const file = path.resolve(
    environment.cwd,
    flags.output ?? trackedFileFor(session.project, frame.id) ?? `${slug(frame.name) || frame.id}.html`,
  )
  if (existsSync(file)) {
    const local = readFileSync(file, 'utf8')
    const tracked = session.project?.data.frames?.[keyFor(session.project, file)]
    const unchangedSincePull = tracked?.frame === frame.id && tracked.base === hashHtml(local)
    if (local !== frame.html && !unchangedSincePull && !flags.yes && !flags.force) {
      const ok = await io.confirm(`${path.relative(environment.cwd, file)} has other content. Overwrite it?`)
      if (!ok) {
        io.err('doop: left unchanged')
        return 1
      }
    }
  }
  writeFileSync(file, frame.html)
  const tracked = recordPull(session, file, frame.id, frame.html)
  io.out(`pulled "${frame.name}" (${frame.id}) -> ${path.relative(environment.cwd, file) || file}`)
  if (!tracked) io.err('doop: no .doop.json covers this file, so push will need --frame and cannot spot canvas edits')
  return 0
}

/** `doop push <file>`: replaces the frame's HTML, refusing when the canvas changed since the pull. */
export async function push(session: Session): Promise<number> {
  const { io, environment } = session.ctx
  const { flags, args } = session.invocation
  const name = args[0] ?? ''
  const file = path.resolve(environment.cwd, name)
  if (!existsSync(file)) throw new CommandError(`no file ${name}`)
  const html = readFileSync(file, 'utf8')
  if (!html.trim()) throw new CommandError(`${name} is empty; refusing to blank a frame`)
  const tracked = session.project?.data.frames?.[keyFor(session.project, file)]
  const frameId = flags.frame ? parseDoopRef(flags.frame).frame : tracked?.frame
  if (!frameId) throw new CommandError(`${name} was not pulled here; pass --frame <id>`)
  const base = tracked?.frame === frameId ? tracked.base : undefined

  const current = await getFrame(session, frameId)
  if (current.html === html) {
    recordPull(session, file, frameId, current.html)
    io.out(`"${current.name}" already matches ${name}`)
    return 0
  }
  if (base && base !== hashHtml(current.html) && !flags.force) {
    const by = current.updatedBy ? ` by ${current.updatedBy}` : ''
    const at = current.updatedAt ? ` at ${current.updatedAt}` : ''
    throw new CommandError(
      `"${current.name}" changed on the canvas since your pull (last edit${by}${at}). ` +
        'Pull it again to merge, or push --force to replace it (the canvas design is kept as a version).',
    )
  }
  if (!base) io.err('doop: no pull is recorded for this file, so edits made on the canvas cannot be spotted')

  const diff = lineDiff(current.html, html, [`frame ${current.name}`, path.basename(file)])
  io.out(`Replace "${current.name}" (${frameId}): +${diff.added} / -${diff.removed} lines`)
  if (current.approvalStatus && current.approvalStatus !== 'draft') {
    io.out(`The frame is ${current.approvalStatus}; changing its HTML withdraws that approval.`)
  }
  if (!flags.yes && !(await io.confirm('Push it?'))) {
    io.err('doop: not pushed (pass --yes when no terminal can answer)')
    return 1
  }
  await session.call('set_frame_html', { frame_id: frameId, html, agent_name: AGENT_NAME })
  /* the server can normalise HTML (component instances), so the new base is what it now serves */
  const after = await getFrame(session, frameId)
  recordPull(session, file, frameId, after.html)
  io.out("pushed. The design it replaced is kept in the frame's history (restore it from the canvas).")
  return 0
}
