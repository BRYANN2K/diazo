import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { sdkPaths } from './scriptSdk.ts'
import { runScript, undoScript } from './scriptToolsBridge.ts'

export const SCRIPT_TOOL_NAMES = ['query_script', 'run_script', 'get_sdk_docs', 'revert_script_run'] as const
export const scriptInputShape = {
  canvas_id: z.string(),
  script: z.string().max(256 * 1024),
  agent_name: z.string().optional(),
  idempotency_key: z.string().max(200).optional(),
  dry_run: z.boolean().optional(),
  result_cap: z.number().int().min(1).max(32768).optional(),
}
export const scriptToolShapes = {
  query_script: scriptInputShape,
  run_script: scriptInputShape,
  get_sdk_docs: {
    namespace: z.enum(['canvas', 'frames', 'tokens', 'components', 'libraries', 'checks', 'compositions', 'search']),
  },
  revert_script_run: { canvas_id: z.string(), run_id: z.string(), agent_name: z.string().optional() },
}

export function getSdkDocs(namespace: string): {
  typings: string
  methods: { path: string; write: boolean }[]
  examples: string[]
} {
  const source = readFileSync(new URL('../shared/scriptSdk.d.ts', import.meta.url), 'utf8')
  const start = source.indexOf(`/* diazo.${namespace} `)
  if (start < 0) throw new Error('unknown SDK namespace')
  const end = source.indexOf('/* diazo.', start + 10)
  const section = source.slice(start, end < 0 ? source.indexOf('/* the global', start) : end)
  return {
    typings: section,
    methods: sdkPaths().filter((p) => p.path.startsWith(namespace + '.')),
    examples:
      namespace === 'frames'
        ? [
            'return await diazo.frames.list()',
            'for (const f of await diazo.frames.list()) await diazo.frames.replaceValues(f.id, {kinds:["color"], match:"exact"})',
          ]
        : [
            `return await diazo.canvas.summary({brief:"the requested design"})`,
            `return await diazo.checks.review("frame-id")`,
          ],
  }
}

export { runScript, undoScript }
