import { parseArgs } from 'node:util'

/** Parsed command line: the command words, its positional arguments and the flags. */
export interface Invocation {
  command: string
  args: string[]
  flags: Flags
}

export interface Flags {
  url?: string
  canvas?: string
  output?: string
  frame?: string
  limit?: number
  all: boolean
  yes: boolean
  force: boolean
  dryRun: boolean
  matchCase: boolean
  help: boolean
  version: boolean
}

export class UsageError extends Error {}

/** Commands and how many positional arguments each takes (min, max). */
const COMMANDS: Record<string, [number, number]> = {
  help: [0, 1],
  config: [0, 0],
  link: [1, 1],
  open: [0, 1],
  find: [1, 1],
  pull: [1, 1],
  push: [1, 1],
  'mcp install': [0, 3],
}

/** Turns argv (without the runtime and script) into an invocation, or throws a UsageError. */
export function parseInvocation(argv: string[]): Invocation {
  let parsed: ReturnType<typeof parse>
  try {
    parsed = parse(argv)
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
  const { values, positionals } = parsed
  const flags: Flags = {
    url: values.url,
    canvas: values.canvas,
    output: values.output,
    frame: values.frame,
    limit: values.limit === undefined ? undefined : parseLimit(values.limit),
    all: values.all ?? false,
    yes: values.yes ?? false,
    force: values.force ?? false,
    dryRun: values['dry-run'] ?? false,
    matchCase: values['match-case'] ?? false,
    help: values.help ?? false,
    version: values.version ?? false,
  }
  const [first, ...rest] = positionals
  if (!first) return { command: 'help', args: [], flags }
  if (first === 'mcp') {
    const [sub, ...args] = rest
    if (sub !== 'install') throw new UsageError('unknown mcp command; did you mean `doop mcp install`?')
    return checkArity({ command: 'mcp install', args, flags })
  }
  if (!(first in COMMANDS)) throw new UsageError(`unknown command "${first}"`)
  return checkArity({ command: first, args: rest, flags })
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      url: { type: 'string' },
      canvas: { type: 'string', short: 'c' },
      output: { type: 'string', short: 'o' },
      frame: { type: 'string', short: 'f' },
      limit: { type: 'string', short: 'n' },
      all: { type: 'boolean', short: 'a' },
      yes: { type: 'boolean', short: 'y' },
      force: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'match-case': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  })
}

function parseLimit(raw: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 500) throw new UsageError('--limit takes a whole number from 1 to 500')
  return n
}

function checkArity(invocation: Invocation): Invocation {
  if (invocation.flags.help) return invocation
  const [min, max] = COMMANDS[invocation.command] ?? [0, 0]
  const n = invocation.args.length
  if (n < min) throw new UsageError(`doop ${invocation.command}: missing argument`)
  if (n > max) throw new UsageError(`doop ${invocation.command}: too many arguments`)
  return invocation
}

/** Accepts a bare id or a doop link (`/c/<canvas>?frame=<frame>`) and returns the ids it names. */
export function parseDoopRef(input: string): { canvas?: string; frame?: string } {
  const trimmed = input.trim()
  const pathMatch = /\/c\/([\w-]+)/.exec(trimmed)
  if (pathMatch) {
    const frame = /[?&]frame=([\w-]+)/.exec(trimmed)?.[1]
    return { canvas: pathMatch[1], ...(frame ? { frame } : {}) }
  }
  if (!/^[\w-]+$/.test(trimmed)) throw new UsageError(`"${input}" is not a doop id or link`)
  return { canvas: trimmed, frame: trimmed }
}

export const HELP = `doop - work with a doop canvas from a project folder

Usage
  doop link <canvas>          Link this folder to a canvas (writes .doop.json)
  doop open [frame]           Open the linked canvas (or one frame) in the browser
  doop find <query>           Search the linked canvas (--all: every canvas)
  doop pull <frame>           Write a frame's HTML to a file (-o file)
  doop push <file>            Replace the frame's HTML with the file, after a check
  doop mcp install [client…]  Add doop's MCP server to claude, codex and devin
  doop config                 Show the server URL and where the agent key comes from

Options
  --url <url>      Server URL (else DOOP_URL, .doop.json, ~/.config/doop/config.json)
  -c, --canvas     Canvas id for find/open instead of .doop.json
  -o, --output     File for pull
  -f, --frame      Frame id for push when the file is not in .doop.json
  -n, --limit      Max search hits (1-500)
  -a, --all        find across every canvas you can open
  -y, --yes        Do not ask for confirmation
  --force          push over a frame changed since the pull
  --dry-run        mcp install: show the diffs, write nothing
  --match-case     Case-sensitive find

Auth
  An agent key (Settings -> Agent keys) from DOOP_AGENT_KEY or the "agentKey"
  field of ~/.config/doop/config.json (chmod 600). It is never printed.
`
