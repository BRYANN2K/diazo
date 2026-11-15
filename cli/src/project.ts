import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** The file `diazo link` writes in a folder that has none. */
export const PROJECT_FILE = '.diazo.json'
/** Every name a project file goes by, the preferred first: `.doop.json`, from
 *  before the rename, is still read and kept under its own name. */
export const PROJECT_FILES = [PROJECT_FILE, '.doop.json'] as const

/** One pulled file: the frame it mirrors and the hash of the frame HTML it was pulled from. */
export interface PulledFile {
  frame: string
  base?: string
}

/** `.diazo.json` (or `.doop.json`): links a project folder to one canvas. File paths are relative to its folder. */
export interface ProjectFile {
  canvas: string
  url?: string
  frames?: Record<string, PulledFile>
}

export interface Project {
  file: string
  dir: string
  data: ProjectFile
}

export class ProjectError extends Error {}

/** The project file a folder holds itself, `.diazo.json` before `.doop.json`; null when it has neither. */
export function projectFileIn(dir: string): string | null {
  for (const name of PROJECT_FILES) {
    const file = path.join(dir, name)
    if (existsSync(file)) return file
  }
  return null
}

/** Finds the nearest `.diazo.json` or `.doop.json` from `start` upwards; null when none is found. */
export function findProject(start: string): Project | null {
  let dir = path.resolve(start)
  for (;;) {
    const file = projectFileIn(dir)
    if (file) return { file, dir, data: readProjectFile(file) }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function readProjectFile(file: string): ProjectFile {
  let data: unknown
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new ProjectError(`${file} is not valid JSON`)
  }
  if (!data || typeof data !== 'object') throw new ProjectError(`${file} must hold a JSON object`)
  const record = data as Record<string, unknown>
  if (typeof record.canvas !== 'string' || !record.canvas) throw new ProjectError(`${file} has no "canvas" id`)
  const project: ProjectFile = { canvas: record.canvas }
  if (typeof record.url === 'string') project.url = record.url
  if (record.frames && typeof record.frames === 'object') {
    const frames: Record<string, PulledFile> = {}
    for (const [key, value] of Object.entries(record.frames as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const entry = value as Record<string, unknown>
      if (typeof entry.frame !== 'string') continue
      frames[key] = { frame: entry.frame, ...(typeof entry.base === 'string' ? { base: entry.base } : {}) }
    }
    project.frames = frames
  }
  return project
}

export function writeProjectFile(file: string, data: ProjectFile): void {
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
}

/** The key a file is stored under: its path relative to the project folder, with forward slashes. */
export function projectKey(project: Project, file: string): string {
  const relative = path.relative(project.dir, path.resolve(file))
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ProjectError(`${file} is outside the linked folder ${project.dir}`)
  }
  return relative.split(path.sep).join('/')
}

/** Canvas to work on: --canvas wins over the linked project file. */
export function resolveCanvas(project: Project | null, flagCanvas?: string): string | undefined {
  return flagCanvas || project?.data.canvas
}
