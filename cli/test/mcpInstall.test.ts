import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { lineDiff } from '../src/diff.ts'
import { main } from '../src/main.ts'
import { editCodexToml, editJsonServers, InstallError, parseClients } from '../src/mcpInstall.ts'
import { fakeIo, KEY, sandbox } from './helpers.ts'

const URL_ = 'https://doop.tailnet.test:8850/mcp'

describe('editJsonServers', () => {
  it('adds doop next to the other servers and keeps everything else', () => {
    const before = JSON.stringify(
      { numStartups: 3, mcpServers: { pad: { type: 'http', url: 'https://pad' } } },
      null,
      2,
    )
    expect(JSON.parse(editJsonServers(before, URL_, { type: 'http', url: URL_ }))).toEqual({
      numStartups: 3,
      mcpServers: { pad: { type: 'http', url: 'https://pad' }, doop: { type: 'http', url: URL_ } },
    })
  })

  it('is a no-op when doop is already there', () => {
    const before = `${JSON.stringify({ mcpServers: { doop: { type: 'http', url: URL_ } } }, null, 2)}\n`
    expect(editJsonServers(before, URL_, { type: 'http', url: URL_ })).toBe(before)
  })

  it('updates the URL but keeps extra settings such as headers', () => {
    const before = JSON.stringify({
      mcpServers: { doop: { type: 'http', url: 'http://old/mcp', headers: { A: 'b' } } },
    })
    const after = JSON.parse(editJsonServers(before, URL_, { type: 'http', url: URL_ })) as {
      mcpServers: { doop: Record<string, unknown> }
    }
    expect(after.mcpServers.doop).toEqual({ type: 'http', url: URL_, headers: { A: 'b' } })
  })

  it('creates a new file and refuses broken ones without quoting them', () => {
    expect(JSON.parse(editJsonServers(null, URL_, { url: URL_, transport: 'http' }))).toEqual({
      mcpServers: { doop: { url: URL_, transport: 'http' } },
    })
    try {
      editJsonServers(`{"token": "${KEY}"`, URL_, { url: URL_ })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(InstallError)
      expect(String(error)).not.toContain(KEY)
    }
    expect(() => editJsonServers('{"mcpServers":{"doop":{"command":"x"}}}', URL_, { url: URL_ })).toThrow(/command/)
  })
})

describe('editCodexToml', () => {
  it('appends a [mcp_servers.doop] table and leaves the rest alone', () => {
    const before = "# mine\nmodel = 'x'\n\n[mcp_servers.paper]\ncommand = 'paper'\n"
    expect(editCodexToml(before, URL_)).toBe(`${before}\n[mcp_servers.doop]\nurl = "${URL_}"\n`)
    expect(editCodexToml('', URL_)).toBe(`[mcp_servers.doop]\nurl = "${URL_}"\n`)
  })

  it('keeps an identical entry and re-enables a disabled one', () => {
    const same = `[mcp_servers.doop]\nurl = '${URL_}'\nbearer_token_env_var = 'X'\n`
    expect(editCodexToml(same, URL_)).toBe(same)
    const disabled = `[mcp_servers.doop]\nurl = "${URL_}"\nenabled = false\n\n[other]\na = 1\n`
    expect(editCodexToml(disabled, URL_)).toBe(disabled.replace('enabled = false', 'enabled = true'))
  })

  it('refuses a different doop connection, like the desktop app', () => {
    expect(() => editCodexToml('[mcp_servers.doop]\nurl = "https://doop.design/mcp"\n', URL_)).toThrow(/different/)
    expect(() => editCodexToml(`[mcp_servers.doop]\nurl = "${URL_}"\ncommand = "x"\n`, URL_)).toThrow(/different/)
  })

  it('refuses inline tables it cannot edit safely', () => {
    expect(() => editCodexToml('mcp_servers = { doop = { url = "x" } }\n', URL_)).toThrow(/inline/)
    expect(() => editCodexToml('mcp_servers.doop.url = "x"\n', URL_)).toThrow(/inline/)
  })
})

describe('parseClients', () => {
  it('defaults to all three and accepts claude-code', () => {
    expect(parseClients([])).toEqual(['claude', 'codex', 'devin'])
    expect(parseClients(['claude-code', 'Codex'])).toEqual(['claude', 'codex'])
    expect(() => parseClients(['cursor'])).toThrow(/unknown client/)
  })
})

describe('lineDiff', () => {
  it('shows only the changed middle with context', () => {
    const diff = lineDiff('a\nb\nc\nd', 'a\nb\nX\nd')
    expect(diff).toMatchObject({ added: 1, removed: 1 })
    expect(diff.text).toContain('-c\n+X')
    expect(lineDiff('same', 'same').text).toBe('')
  })
})

describe('doop mcp install', () => {
  let box: ReturnType<typeof sandbox>
  afterEach(() => box?.cleanup())

  function setup() {
    box = sandbox()
    box.writeUserConfig({ url: 'https://doop.tailnet.test:8850', agentKey: KEY })
    const claude = path.join(box.home, '.claude.json')
    writeFileSync(claude, `${JSON.stringify({ numStartups: 1, mcpServers: {} }, null, 2)}\n`, { mode: 0o600 })
    mkdirSync(path.join(box.home, '.codex'))
    writeFileSync(path.join(box.home, '.codex', 'config.toml'), "model = 'x'\n")
    return { claude }
  }

  it('shows each diff, backs up, writes the URL and never a token', async () => {
    const { claude } = setup()
    const { io, out } = fakeIo([true, true, true])
    expect(await main(['mcp', 'install'], { environment: box.environment(), io })).toBe(0)
    const claudeText = readFileSync(claude, 'utf8')
    expect((JSON.parse(claudeText) as { mcpServers: unknown }).mcpServers).toEqual({
      doop: { type: 'http', url: URL_ },
    })
    expect(statSync(claude).mode & 0o777).toBe(0o600)
    expect(readFileSync(path.join(box.home, '.codex', 'config.toml'), 'utf8')).toContain(`url = "${URL_}"`)
    const devin = readFileSync(path.join(box.home, '.config', 'devin', 'mcp_config.json'), 'utf8')
    expect(JSON.parse(devin)).toEqual({ mcpServers: { doop: { url: URL_, transport: 'http' } } })
    for (const text of [claudeText, devin, out.join('\n')]) expect(text).not.toContain(KEY)
    expect(out.join('\n')).toContain('+    "doop": {')
    const backups = readdirSync(box.home).filter((f) => f.startsWith('.claude.json.bak-doop-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(path.join(box.home, backups[0] ?? ''), 'utf8')).toContain('"mcpServers": {}')
    expect(readdirSync(path.join(box.home, '.codex')).some((f) => f.startsWith('config.toml.bak-doop-'))).toBe(true)
  })

  it('writes nothing on --dry-run or when declined', async () => {
    const { claude } = setup()
    const before = readFileSync(claude, 'utf8')
    await main(['mcp', 'install', 'claude', '--dry-run'], { environment: box.environment(), io: fakeIo().io })
    expect(readFileSync(claude, 'utf8')).toBe(before)
    await main(['mcp', 'install', 'claude'], { environment: box.environment(), io: fakeIo([false]).io })
    expect(readFileSync(claude, 'utf8')).toBe(before)
    expect(readdirSync(box.home).filter((f) => f.includes('bak-doop'))).toHaveLength(0)
  })

  it('reports a config it refuses and keeps going', async () => {
    setup()
    writeFileSync(path.join(box.home, '.codex', 'config.toml'), '[mcp_servers.doop]\nurl = "https://elsewhere/mcp"\n')
    const { io, err } = fakeIo()
    expect(await main(['mcp', 'install', '-y'], { environment: box.environment(), io })).toBe(1)
    expect(err.join('\n')).toContain('different doop connection')
    expect(readFileSync(path.join(box.home, '.claude.json'), 'utf8')).toContain(URL_)
  })
})
