import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline/promises'

/** Terminal side effects, injected so commands stay testable. */
export interface Io {
  out: (line: string) => void
  err: (line: string) => void
  /** Asks a yes/no question; false when nobody can answer (no TTY). */
  confirm: (question: string) => Promise<boolean>
  openUrl: (url: string) => Promise<void>
}

export function realIo(): Io {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    confirm: async (question) => {
      if (!process.stdin.isTTY) return false
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      try {
        const answer = await rl.question(`${question} [y/N] `)
        return /^y(es)?$/i.test(answer.trim())
      } finally {
        rl.close()
      }
    },
    openUrl: (url) => openInBrowser(url),
  }
}

/** The system command that opens a URL in the default browser, as argv (never through a shell). */
export function openCommand(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === 'darwin') return ['open', [url]]
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]]
  return ['xdg-open', [url]]
}

function openInBrowser(url: string): Promise<void> {
  const [command, args] = openCommand(process.platform, url)
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.once('error', () => reject(new Error(`could not run ${command}; open ${url} yourself`)))
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
