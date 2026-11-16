/** shared/blender.ts — the Blender op contract (phase 4, ADR 0011).
 *
 *  An agent never talks to Blender. It submits an op through the server;
 *  the desktop shell claims it, runs the allowlisted blender-mcp tool and
 *  posts the result back. `klass` is the approval class the shell must hold
 *  before it runs the tool: reads are open once the bridge is on, writes and
 *  renders each need a recorded grant in the app. */

/** the ops the server relays — a subset of the shell's blender-mcp allowlist */
export const BLENDER_OP_TOOLS = [
  'get_scene_info',
  'get_object_info',
  'set_material',
  'add_light',
  'render_frame',
] as const
export type BlenderOpTool = (typeof BLENDER_OP_TOOLS)[number]

/** read ops need only the bridge; writes and renders need a grant each */
export const BLENDER_OP_CLASS: Record<BlenderOpTool, 'read' | 'write' | 'render'> = {
  get_scene_info: 'read',
  get_object_info: 'read',
  set_material: 'write',
  add_light: 'write',
  render_frame: 'render',
}

export const BLENDER_OP_STATES = ['queued', 'running', 'done', 'failed'] as const
export type BlenderOpState = (typeof BLENDER_OP_STATES)[number]

export interface BlenderOp {
  id: string
  canvasId: string
  tool: BlenderOpTool
  klass: 'read' | 'write' | 'render'
  /** the tool's arguments, validated against its shape server-side */
  args?: Record<string, unknown>
  state: BlenderOpState
  result?: unknown
  error?: string
  /** the desktop device that claimed it */
  deviceId?: string
  requestedBy: string
  createdAt: number
  updatedAt: number
}
