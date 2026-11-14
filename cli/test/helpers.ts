import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FetchLike } from '../src/client.ts'
import type { Environment } from '../src/config.ts'
import type { Io } from '../src/io.ts'

export const KEY = 'dpk_testtesttesttesttesttest'

/** A throwaway home and project folder, so tests never read the real ~/.config. */
export function sandbox() {
  const root = mkdtempSync(path.join(tmpdir(), 'doop-cli-'))
  const home = path.join(root, 'home')
  const cwd = path.join(root, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  return {
    root,
    home,
    cwd,
    environment(env: Record<string, string | undefined> = {}): Environment {
      return { env, home, cwd }
    },
    writeUserConfig(data: unknown, mode = 0o600) {
      const dir = path.join(home, '.config', 'doop')
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, 'config.json'), JSON.stringify(data), { mode })
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

/** Records output and answers confirmations from a queue (default: no). */
export function fakeIo(answers: boolean[] = []) {
  const out: string[] = []
  const err: string[] = []
  const opened: string[] = []
  const questions: string[] = []
  const io: Io = {
    out: (line) => void out.push(line),
    err: (line) => void err.push(line),
    confirm: (question) => {
      questions.push(question)
      return Promise.resolve(answers.shift() ?? false)
    },
    openUrl: (url) => {
      opened.push(url)
      return Promise.resolve()
    },
  }
  return { io, out, err, opened, questions }
}

export interface RecordedCall {
  url: string
  name: string
  args: Record<string, unknown>
  authorization: string | null
}

/** A fake MCP server: each tool name maps to a handler returning the tool's JSON payload. */
export function fakeServer(tools: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: RecordedCall[] = []
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init.body)) as { params: { name: string; arguments: Record<string, unknown> } }
    const headers = new Headers(init.headers)
    calls.push({
      url,
      name: body.params.name,
      args: body.params.arguments,
      authorization: headers.get('authorization'),
    })
    const handler = tools[body.params.name]
    if (!handler)
      return Response.json({ result: { isError: true, content: [{ type: 'text', text: 'Error: no tool' }] } })
    const payload = handler(body.params.arguments)
    return Response.json({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
    })
  }
  return { fetch, calls }
}
