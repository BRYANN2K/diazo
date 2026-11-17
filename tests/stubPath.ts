import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import path from 'node:path'

/* The PATH the installer tests run the scripts under: the stub dir, then
   only these everyday tools, symlinked into a dir beside it. A stub adds a
   command but cannot hide one — on a PATH with /usr/bin a runner's real
   docker, podman or systemctl answers where the test meant "not installed".
   Here only a stub in bin/ provides a runtime, and removing the stub really
   removes it. */
const TOOLS = [
  'awk',
  'base64',
  'basename',
  'cat',
  'chmod',
  'chown',
  'cmp',
  'cp',
  'cut',
  'date',
  'dirname',
  'env',
  'find',
  'grep',
  'gunzip',
  'gzip',
  'head',
  'id',
  'install',
  'ln',
  'ls',
  'mkdir',
  'mktemp',
  'mv',
  'openssl',
  'pgrep',
  'pkill',
  'readlink',
  'rm',
  'sed',
  'sh',
  'sha256sum',
  'shasum',
  'sleep',
  'sort',
  'stat',
  'tar',
  'touch',
  'tr',
  'wc',
]

/* each tool's real path, resolved once on the host's own PATH */
const found = new Map<string, string>()

const locate = (tool: string): string => {
  let real = found.get(tool)
  if (real === undefined) {
    real = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim()
    found.set(tool, real)
  }
  return real
}

/* Links the tools into <bin>/../core and answers `${bin}:<core>` to put on
   PATH. A tool missing on the host is simply left out. */
export function stubPath(bin: string): string {
  const core = path.join(path.dirname(bin), 'core')
  mkdirSync(core, { recursive: true })
  for (const tool of TOOLS) {
    const target = path.join(core, tool)
    const real = locate(tool)
    if (real.startsWith('/') && !existsSync(target)) symlinkSync(real, target)
  }
  return `${bin}:${core}`
}
