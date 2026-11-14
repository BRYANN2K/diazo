/**
 * Frame → code wire types (server/frameToCode.ts builds, the modal shows).
 * The component is generated server-side from the frame, the canvas tokens
 * and the component ↔ file mapping, then sent as a patch for review.
 */
import type { PatchSummary } from './patch.ts'

export const FRAME_CODE_FRAMEWORKS = ['react', 'astro'] as const
export type FrameCodeFramework = (typeof FRAME_CODE_FRAMEWORKS)[number]

export interface FrameCodeInput {
  framework: FrameCodeFramework
  /** repo-relative output file; defaults to the frame's mapping or src/components/<Name> */
  path?: string
  /** the component's export name; defaults to the frame name, PascalCased */
  name?: string
}

export interface FrameCodeFile {
  path: string
  text: string
}

export interface FrameCode {
  framework: FrameCodeFramework
  name: string
  /** the component file first; React adds a sibling stylesheet */
  files: FrameCodeFile[]
  /** components imported through their mapping */
  imports: { component: string; name: string; from: string }[]
  /** components the frame uses that have no mapping — inlined as markup */
  unmapped: string[]
  /** tokens the output names */
  tokens: string[]
  /** scripts the frame carried, left out of the component */
  droppedScripts: number
}

export interface FrameCodePreview {
  code: FrameCode
  /** '' when the repo already holds exactly these files */
  patch: string
  summary: PatchSummary | null
  repo: string
}
