/**
 * Unified patches for the linked repo — the only shape doop proposes repo
 * changes in. The server builds them from line edits (token sync, frame →
 * code), the UI previews them, and the desktop app's `repo_apply_patch`
 * re-parses and applies them after its own native dialog, refusing any hunk
 * whose context no longer matches. The caps mirror
 * `desktop/src-tauri/src/repo.rs` — keep the two in step.
 */

export const PATCH_MAX_FILES = 24
export const PATCH_MAX_BYTES = 1024 * 1024
/** The resulting file may not grow past the read cap — doop could not read it back. */
export const PATCH_MAX_FILE_BYTES = 512 * 1024
export const PATCH_CONTEXT = 3

/** A line-level edit of one file: replace lines [start, end) — 0-based —
 *  with `lines`. An insertion has start === end. */
export interface LineEdit {
  start: number
  end: number
  lines: string[]
}

export interface FilePatch {
  path: string
  /** the file is created — it must not exist yet */
  create: boolean
  added: number
  removed: number
}

export interface PatchSummary {
  files: FilePatch[]
  bytes: number
}

const splitLines = (text: string) => {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * The unified diff turning `before` into the text `edits` produce. Edits
 * must not overlap; they are applied in order of `start`. `before` null
 * means a new file. Answers '' when nothing changes.
 */
export function diffFromEdits(path: string, before: string | null, edits: readonly LineEdit[]): string {
  const old = before === null ? [] : splitLines(before)
  const sorted = [...edits].sort((a, b) => a.start - b.start)
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i]!
    if (e.start < 0 || e.end < e.start || e.end > old.length) throw new Error(`edit out of range in ${path}`)
    if (i > 0 && e.start < sorted[i - 1]!.end) throw new Error(`overlapping edits in ${path}`)
  }
  const real = sorted.filter(
    (e) => e.end - e.start !== e.lines.length || e.lines.some((l, i) => l !== old[e.start + i]),
  )
  if (!real.length) return ''
  /* group edits whose context windows touch into one hunk */
  const groups: LineEdit[][] = []
  for (const e of real) {
    const last = groups[groups.length - 1]
    if (last && e.start - last[last.length - 1]!.end <= PATCH_CONTEXT * 2) last.push(e)
    else groups.push([e])
  }
  const out = [before === null ? '--- /dev/null' : `--- a/${path}`, `+++ b/${path}`]
  let shift = 0 // new-file line offset accumulated by earlier hunks
  for (const group of groups) {
    const from = Math.max(0, group[0]!.start - PATCH_CONTEXT)
    const to = Math.min(old.length, group[group.length - 1]!.end + PATCH_CONTEXT)
    const body: string[] = []
    let cursor = from
    let added = 0
    let removed = 0
    for (const e of group) {
      for (; cursor < e.start; cursor++) body.push(` ${old[cursor]}`)
      for (let k = e.start; k < e.end; k++) body.push(`-${old[k]}`)
      for (const line of e.lines) body.push(`+${line}`)
      removed += e.end - e.start
      added += e.lines.length
      cursor = e.end
    }
    for (; cursor < to; cursor++) body.push(` ${old[cursor]}`)
    const oldCount = to - from
    const newCount = oldCount - removed + added
    const oldStart = oldCount === 0 ? from : from + 1
    const newStart = newCount === 0 ? from + shift : from + shift + 1
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...body)
    shift += added - removed
  }
  return out.join('\n') + '\n'
}

/** A whole-file replacement (or creation) as a patch. */
export function diffReplace(path: string, before: string | null, after: string): string {
  const old = before === null ? [] : splitLines(before)
  return diffFromEdits(path, before, [{ start: 0, end: old.length, lines: splitLines(after) }])
}

/** Why a patch path cannot be written, or null when it can (shape only —
 *  the desktop app re-checks against the real folder). */
export function patchPathProblem(path: string): string | null {
  if (!path || path.length > 500) return 'path is empty or too long'
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return 'path must be repo-relative'
  for (const seg of path.split('/')) if (!seg || seg === '.' || seg === '..') return 'path has empty or dot segments'
  if (/[\\:*?"<>|\0]/.test(path)) return 'path has characters a repo should not carry'
  if (/(^|\/)(\.git|node_modules|\.svn|\.hg)(\/|$)/i.test(path)) return 'path is inside a skipped directory'
  return null
}

/**
 * Read a patch's file list back — the summary the preview shows, and a
 * sanity check that the server only ever hands the device a well-formed,
 * bounded patch. Throws on anything malformed.
 */
export function summarizePatch(patch: string): PatchSummary {
  const bytes = new TextEncoder().encode(patch).length
  if (bytes > PATCH_MAX_BYTES) throw new Error(`the patch is over the ${PATCH_MAX_BYTES}-byte cap`)
  const lines = patch.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const files: FilePatch[] = []
  let i = 0
  while (i < lines.length) {
    const minus = lines[i]!
    if (!minus.startsWith('--- ')) throw new Error(`line ${i + 1}: expected a --- header`)
    const plus = lines[i + 1] ?? ''
    if (!plus.startsWith('+++ b/')) throw new Error(`line ${i + 2}: expected a +++ b/ header`)
    const path = plus.slice('+++ b/'.length)
    const create = minus === '--- /dev/null'
    if (!create && minus !== `--- a/${path}`) throw new Error(`line ${i + 1}: the --- and +++ paths differ`)
    const bad = patchPathProblem(path)
    if (bad) throw new Error(`${path}: ${bad}`)
    if (files.some((f) => f.path === path)) throw new Error(`${path}: appears twice`)
    i += 2
    const file: FilePatch = { path, create, added: 0, removed: 0 }
    let hunks = 0
    while (i < lines.length && lines[i]!.startsWith('@@')) {
      const m = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(lines[i]!)
      if (!m) throw new Error(`line ${i + 1}: malformed hunk header`)
      let oldLeft = Number(m[2])
      let newLeft = Number(m[4])
      if (create && oldLeft !== 0) throw new Error(`${path}: a new file's hunk must start empty`)
      i++
      hunks++
      while (oldLeft > 0 || newLeft > 0) {
        const line = lines[i]
        if (line === undefined) throw new Error(`${path}: hunk ends early`)
        if (line.startsWith(' ')) {
          oldLeft--
          newLeft--
        } else if (line.startsWith('-')) {
          oldLeft--
          file.removed++
        } else if (line.startsWith('+')) {
          newLeft--
          file.added++
        } else throw new Error(`line ${i + 1}: unexpected hunk line`)
        if (oldLeft < 0 || newLeft < 0) throw new Error(`${path}: hunk counts do not add up`)
        i++
      }
    }
    if (!hunks) throw new Error(`${path}: no hunks`)
    files.push(file)
    if (files.length > PATCH_MAX_FILES) throw new Error(`at most ${PATCH_MAX_FILES} files per patch`)
  }
  if (!files.length) throw new Error('the patch is empty')
  return { files, bytes }
}

/**
 * Apply a patch to in-memory files — what the desktop app does natively,
 * mirrored for previews and tests. `read` answers a file's current text, or
 * null when it does not exist. Context must match exactly; no fuzz.
 */
export function applyPatch(patch: string, read: (path: string) => string | null): Map<string, string> {
  summarizePatch(patch)
  const out = new Map<string, string>()
  const lines = patch.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  let i = 0
  while (i < lines.length) {
    const create = lines[i] === '--- /dev/null'
    const path = lines[i + 1]!.slice('+++ b/'.length)
    i += 2
    const current = read(path)
    if (create && current !== null) throw new Error(`${path}: already exists`)
    if (!create && current === null) throw new Error(`${path}: missing`)
    const src = current === null ? [] : splitLines(current)
    const result: string[] = []
    let cursor = 0
    while (i < lines.length && lines[i]!.startsWith('@@')) {
      const m = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(lines[i]!)!
      const oldStart = Number(m[2]) === 0 ? Number(m[1]) : Number(m[1]) - 1
      if (oldStart < cursor) throw new Error(`${path}: hunks out of order`)
      for (; cursor < oldStart; cursor++) {
        if (cursor >= src.length) throw new Error(`${path}: hunk past the end of the file`)
        result.push(src[cursor]!)
      }
      i++
      while (i < lines.length && !lines[i]!.startsWith('@@') && !lines[i]!.startsWith('--- ')) {
        const line = lines[i]!
        const body = line.slice(1)
        if (line[0] === '+') result.push(body)
        else {
          if (src[cursor] !== body)
            throw new Error(`${path}: the file changed since the patch was made (line ${cursor + 1})`)
          if (line[0] === ' ') result.push(body)
          cursor++
        }
        i++
      }
    }
    for (; cursor < src.length; cursor++) result.push(src[cursor]!)
    const text = result.length ? result.join('\n') + '\n' : ''
    if (new TextEncoder().encode(text).length > PATCH_MAX_FILE_BYTES)
      throw new Error(`${path}: over the ${PATCH_MAX_FILE_BYTES}-byte file cap`)
    out.set(path, text)
  }
  return out
}
