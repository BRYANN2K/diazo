/**
 * Component ↔ file mapping: where a doop component or frame lives in the
 * canvas's linked repo — a repo-relative path plus the export name. The
 * mapping is a canvas-level fact (collaborators see the same one); storing
 * it never touches the repo. Suggestions come from the linked project's
 * `repo_list` / `repo_search` reads, and implementers read the mapping in
 * get_component, get_frame and the Stip handoff pack.
 */

export const CODE_LINK_KINDS = ['component', 'frame'] as const
export type CodeLinkKind = (typeof CODE_LINK_KINDS)[number]

export const CODE_LINK_SOURCES = ['manual', 'suggested', 'generated'] as const
/** how the mapping was made: typed by a person, picked from a suggestion,
 *  or written by doop's own frame → code export */
export type CodeLinkSource = (typeof CODE_LINK_SOURCES)[number]

export const CODE_LINK_MAX_PATH = 500
export const CODE_LINK_MAX_EXPORT = 200

export interface CodeLink {
  id: string
  canvasId: string
  targetKind: CodeLinkKind
  targetId: string
  /** repo-relative, `/`-separated: `src/components/Button.tsx` */
  path: string
  /** the export the target maps to — `Button`, or `default` */
  exportName: string | null
  source: CodeLinkSource
  updatedBy: string
  updatedAt: number
}

export interface CodeLinkInput {
  targetKind: CodeLinkKind
  targetId: string
  path: string
  exportName?: string | null
  source?: CodeLinkSource
}

export function isCodeLinkKind(value: unknown): value is CodeLinkKind {
  return value === 'component' || value === 'frame'
}

/** `./src//a.tsx` → `src/a.tsx`; backslashes become slashes. */
export function normalizeCodePath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg && seg !== '.')
    .join('/')
}

/** Why `path` cannot name a file in a repo, or null when it can. Mirrors the
 *  read sandbox's shape rules: relative, no `..`, nothing absolute. */
export function codePathProblem(path: string): string | null {
  const raw = path.trim()
  if (!raw) return 'path is empty'
  if (raw.length > CODE_LINK_MAX_PATH) return `path is over ${CODE_LINK_MAX_PATH} characters`
  if (raw.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(raw)) return 'path must be relative to the repo root'
  const clean = normalizeCodePath(raw)
  if (!clean) return 'path is empty'
  if (clean.split('/').some((seg) => seg === '..')) return 'path may not contain ..'
  if (/[\0<>|"?*]/.test(clean)) return 'path has characters a repo should not carry'
  return null
}

/** An export name is a JS identifier, or `default`. */
export function exportNameProblem(name: string): string | null {
  if (name.length > CODE_LINK_MAX_EXPORT) return `export name is over ${CODE_LINK_MAX_EXPORT} characters`
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return 'export name must be an identifier like Button, or default'
  return null
}

/** The short form an agent or a person reads: `src/Button.tsx#Button`. */
export function codeLinkLabel(link: Pick<CodeLink, 'path' | 'exportName'>): string {
  return link.exportName ? `${link.path}#${link.exportName}` : link.path
}

/** What agents read in get_component / get_frame / the handoff pack. */
export function describeCodeLink(link: CodeLink) {
  return {
    path: link.path,
    ...(link.exportName ? { export: link.exportName } : {}),
    source: link.source,
    updated_by: link.updatedBy,
    updated_at: new Date(link.updatedAt).toISOString(),
  }
}
