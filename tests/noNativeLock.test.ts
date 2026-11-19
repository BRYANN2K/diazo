import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The data-dir lock is built in (node:sqlite), so nothing native ships
 * for it: no fs-ext anywhere, no install-scripts allowlist it needed,
 * and the bundle stages exactly the externals it still cannot inline —
 * sharp (its .node prebuilds) and PGlite (its .wasm).
 */

const ROOT = process.cwd()
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8')

describe('no native lock module', () => {
  it('package.json carries no fs-ext and no trustedDependencies', () => {
    const pkg = JSON.parse(read('package.json')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      trustedDependencies?: string[]
    }
    expect(pkg.trustedDependencies).toBeUndefined()
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain('fs-ext')
    expect(Object.keys(pkg.devDependencies ?? {})).not.toContain('@types/fs-ext')
  })

  it('bun.lock has no fs-ext package entry', () => {
    expect(read('bun.lock')).not.toContain('"fs-ext"')
    expect(read('bun.lock')).not.toContain('fs-ext@')
    expect(read('bun.lock')).not.toContain('@types/fs-ext')
  })

  it('the bundle ships exactly sharp and @electric-sql/pglite', () => {
    const script = read('scripts/build-embedded-server.ts')
    const shipped = /const SHIPPED = \[([^\]]*)\]/.exec(script)?.[1] ?? ''
    const names = [...shipped.matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(names).toEqual(['sharp', '@electric-sql/pglite'])
    expect(script).not.toContain('fs-ext')
  })
})
