/**
 * The shapes the canvas UI's handoff preview (HandoffModal) still reads.
 * The pack builder, its REST routes and the repo write it fed are gone —
 * these types stay only until the frontend pass removes the modal.
 */

/** One file of the drafted handoff: text (utf-8) or base64 (binary). */
export interface HandoffFile {
  path: string
  text?: string
  base64?: string
}

/** The drafted handoff the preview modal edits before writing. */
export interface HandoffPack {
  changeId: string
  dir: string
  title: string
  proposal: string
  spec: string
  tasks: string
  files: HandoffFile[]
  draftedBy: 'agent' | 'template'
  modelLabel?: string
  warnings: string[]
}

/** What the modal's write answered on success. */
export interface HandoffWriteResult {
  dir: string
  written: string[]
  /** the link's display name — the folder's basename on the Mac */
  repo: string
}
