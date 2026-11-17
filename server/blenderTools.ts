/** Blender tool definitions are reused by both canvas tool transports.
 *  Every tool queues an op the desktop shell runs through its allowlisted
 *  blender-mcp bridge — poll get_blender_result for the outcome. */
import { z } from 'zod'
import { getBlenderOp, submitBlenderOp, BlenderError } from './blenderOps.ts'
import { canAccessCanvas, canEditCanvas } from './access.ts'
import type { Canvas } from '../shared/types.ts'
import { BLENDER_OP_ARGS, type BlenderOpTool } from '../shared/blender.ts'

export const BLENDER_TOOLS = [
  {
    name: 'blender_get_scene',
    title: 'Read the Blender scene',
    description:
      'Read the scene tree of the Blender session on your desktop (names, objects, materials). Queues a read op; poll get_blender_result.',
    readOnly: true,
    tool: 'get_scene_info',
    shape: {},
  },
  {
    name: 'blender_get_object',
    title: 'Read a Blender object',
    description: 'Read one object in the desktop Blender scene by name. Queues a read op; poll get_blender_result.',
    readOnly: true,
    tool: 'get_object_info',
    shape: { name: z.string().min(1).max(200) },
  },
  {
    name: 'blender_set_material',
    title: 'Set a Blender material',
    description:
      "Set an object's material in the desktop Blender scene. Needs the shell's write approval; poll get_blender_result.",
    readOnly: false,
    tool: 'set_material',
    shape: { object: z.string().min(1).max(200), material: z.string().min(1).max(200) },
  },
  {
    name: 'blender_add_light',
    title: 'Add a Blender light',
    description:
      "Add a light to the desktop Blender scene (type POINT, SUN, SPOT or AREA). Needs the shell's write approval.",
    readOnly: false,
    tool: 'add_light',
    shape: {
      light_type: z.enum(['POINT', 'SUN', 'SPOT', 'AREA']).default('POINT'),
      name: z.string().max(200).optional(),
      location: z.array(z.number().finite()).length(3).optional(),
    },
  },
  {
    name: 'blender_render_frame',
    title: 'Render a Blender frame',
    description:
      "Render one frame of the desktop Blender scene to a file. Needs the shell's render approval; the shell picks the output path, the result reports it. Poll get_blender_result.",
    readOnly: false,
    tool: 'render_frame',
    /* no filepath: a caller never chooses where a render lands —
       shared/blender.ts's BLENDER_OP_ARGS is the same contract the
       shell re-checks before relaying */
    shape: (BLENDER_OP_ARGS.render_frame as z.ZodObject<z.ZodRawShape>).shape,
  },
  {
    name: 'get_blender_result',
    title: 'Read a Blender result',
    description: 'Read your Blender op by op_id — queued, running, done or failed.',
    readOnly: true,
    tool: null,
    shape: { op_id: z.string().min(1).max(100) },
  },
] as const

export async function runBlenderTool(name: string, canvas: Canvas, userId: string, raw: unknown): Promise<unknown> {
  if (!canAccessCanvas(userId, canvas)) throw new BlenderError('canvas view access required')
  const tool = BLENDER_TOOLS.find((item) => item.name === name)
  if (!tool) throw new BlenderError('unknown blender tool')
  if (!tool.readOnly && !canEditCanvas(userId, canvas)) throw new BlenderError('canvas edit access required')
  const parsed = z.object(tool.shape).strict().safeParse(raw)
  if (!parsed.success) throw new BlenderError(parsed.error.issues[0]?.message ?? 'invalid blender arguments')
  const input = parsed.data as Record<string, unknown>
  if (name === 'get_blender_result') {
    const op = await getBlenderOp(String(input.op_id))
    if (!op || op.requestedBy !== userId || op.canvasId !== canvas.id) throw new BlenderError('no such blender op')
    return { op }
  }
  return { op: await submitBlenderOp(userId, canvas.id, { tool: tool.tool as BlenderOpTool, args: input }) }
}
