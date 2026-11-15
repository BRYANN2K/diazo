import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigError, normaliseServerUrl, resolveSettings, userConfigPath } from '../src/config.ts'
import { findProject, projectKey, ProjectError, resolveCanvas } from '../src/project.ts'
import { KEY, sandbox } from './helpers.ts'

let box: ReturnType<typeof sandbox>
afterEach(() => box?.cleanup())

describe('settings', () => {
  it('reads the URL and key from the user file outside the repo', () => {
    box = sandbox()
    box.writeUserConfig({ url: 'https://doop.tailnet.test:8850/', agentKey: KEY })
    const settings = resolveSettings(box.environment(), {})
    expect(settings).toEqual({ url: 'https://doop.tailnet.test:8850', urlSource: 'file', key: KEY, keySource: 'file' })
  })

  it('puts --url, then DOOP_URL, then .doop.json ahead of the file', () => {
    box = sandbox()
    box.writeUserConfig({ url: 'https://file.test' })
    const env = box.environment({ DOOP_URL: 'https://env.test' })
    expect(resolveSettings(env, { flagUrl: 'https://flag.test' }).url).toBe('https://flag.test')
    expect(resolveSettings(env, { projectUrl: 'https://project.test' }).url).toBe('https://env.test')
    expect(resolveSettings(box.environment(), { projectUrl: 'https://project.test' }).urlSource).toBe('project')
  })

  it('prefers DOOP_AGENT_KEY over the file', () => {
    box = sandbox()
    box.writeUserConfig({ agentKey: 'dpk_fromfilefromfilefromfile' })
    const settings = resolveSettings(box.environment({ DOOP_AGENT_KEY: KEY }), {})
    expect(settings.key).toBe(KEY)
    expect(settings.keySource).toBe('env')
  })

  it('has no hard-coded server', () => {
    box = sandbox()
    expect(resolveSettings(box.environment(), {}).url).toBeUndefined()
  })

  it.skipIf(process.platform === 'win32')('refuses a key in a file others can read', () => {
    box = sandbox()
    box.writeUserConfig({ agentKey: KEY }, 0o644)
    expect(() => resolveSettings(box.environment(), {})).toThrow(/chmod 600/)
  })

  it('never quotes the file when it is broken', () => {
    box = sandbox()
    const file = userConfigPath(box.environment())
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `{"agentKey": "${KEY}"`, { mode: 0o600 })
    try {
      resolveSettings(box.environment(), {})
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError)
      expect(String(error)).not.toContain(KEY)
    }
  })

  it('honours XDG_CONFIG_HOME', () => {
    box = sandbox()
    expect(userConfigPath(box.environment({ XDG_CONFIG_HOME: '/x' }))).toBe(path.join('/x', 'doop', 'config.json'))
  })

  it('normalises server URLs', () => {
    expect(normaliseServerUrl('http://localhost:4300/mcp')).toBe('http://localhost:4300')
    expect(() => normaliseServerUrl('ftp://x')).toThrow(ConfigError)
    expect(() => normaliseServerUrl('https://u:p@x.test')).toThrow(/credentials/)
  })
})

describe('project file resolution', () => {
  it('finds the nearest file walking up', () => {
    box = sandbox()
    writeFileSync(path.join(box.cwd, '.doop.json'), JSON.stringify({ canvas: 'outer' }))
    const nested = path.join(box.cwd, 'apps', 'web')
    mkdirSync(nested, { recursive: true })
    expect(findProject(nested)?.data.canvas).toBe('outer')
    writeFileSync(path.join(box.cwd, 'apps', '.doop.json'), JSON.stringify({ canvas: 'inner' }))
    expect(findProject(nested)?.data.canvas).toBe('inner')
  })

  it('reads .diazo.json, and prefers it over a .doop.json in the same folder', () => {
    box = sandbox()
    writeFileSync(path.join(box.cwd, '.doop.json'), JSON.stringify({ canvas: 'legacy' }))
    expect(findProject(box.cwd)?.data.canvas).toBe('legacy')
    writeFileSync(path.join(box.cwd, '.diazo.json'), JSON.stringify({ canvas: 'current' }))
    const project = findProject(box.cwd)!
    expect(project.data.canvas).toBe('current')
    expect(path.basename(project.file)).toBe('.diazo.json')
  })

  it('returns null when no folder is linked', () => {
    box = sandbox()
    expect(findProject(box.cwd)).toBeNull()
  })

  it('rejects a file without a canvas', () => {
    box = sandbox()
    writeFileSync(path.join(box.cwd, '.doop.json'), '{}')
    expect(() => findProject(box.cwd)).toThrow(ProjectError)
  })

  it('keeps only well-formed pulled files', () => {
    box = sandbox()
    writeFileSync(
      path.join(box.cwd, '.doop.json'),
      JSON.stringify({ canvas: 'c', frames: { 'a.html': { frame: 'f1', base: 'h' }, 'b.html': 3 } }),
    )
    expect(findProject(box.cwd)?.data.frames).toEqual({ 'a.html': { frame: 'f1', base: 'h' } })
  })

  it('stores files relative to the project folder', () => {
    box = sandbox()
    writeFileSync(path.join(box.cwd, '.doop.json'), JSON.stringify({ canvas: 'c' }))
    const project = findProject(box.cwd)!
    expect(projectKey(project, path.join(box.cwd, 'design', 'home.html'))).toBe('design/home.html')
    expect(() => projectKey(project, path.join(box.root, 'elsewhere.html'))).toThrow(/outside/)
  })

  it('lets --canvas override the link', () => {
    expect(resolveCanvas({ file: '', dir: '', data: { canvas: 'linked' } }, 'flag')).toBe('flag')
    expect(resolveCanvas({ file: '', dir: '', data: { canvas: 'linked' } })).toBe('linked')
    expect(resolveCanvas(null)).toBeUndefined()
  })
})
