import { afterEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  plan: vi.fn(),
  acp: vi.fn(),
  accounts: vi.fn(async (): Promise<unknown[]> => []),
  online: vi.fn(),
  catalog: vi.fn((): unknown[] => []),
  start: vi.fn(),
}))
/* no default marked: the fallback order decides */
vi.mock('../server/db/index.ts', () => ({ db: { select: () => ({ from: () => ({ where: async () => [] }) }) } }))
vi.mock('../server/localAgentPreferences.ts', () => ({ getLocalAgentPreference: mocks.plan }))
vi.mock('../server/acpAgentPreferences.ts', () => ({ getAcpPreferences: mocks.acp }))
vi.mock('../server/modelAccounts.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/modelAccounts.ts')>()),
  getAccounts: mocks.accounts,
}))
vi.mock('../server/localAgentRuns.ts', () => ({
  localAgentRuns: { online: mocks.online, catalog: mocks.catalog, start: mocks.start },
}))
import { pickModel } from '../server/agentModel.ts'
import { listRunners } from '../server/agentRunners.ts'
import { resolveDefault } from '../server/agentDefaults.ts'
import type { LocalAgentRuns, LocalHarnessRequest } from '../server/localAgentRuns.ts'
import type { ModelAccount } from '../server/modelAccounts.ts'
import {
  acpMenu,
  acpRunArgs,
  devinFamilies,
  devinModelId,
  grokModels,
  isAcpModel,
  type AcpCatalogModel,
} from '../shared/acpAgent.ts'
import { isLocalRunner, isRunnerProvider, parseRunnerPick, RUNNER_NAMES } from '../shared/agentRunner.ts'
import { fromAcpUsage } from '../shared/usage.ts'

const { LocalAgentRuns: RealRuns } =
  await vi.importActual<typeof import('../server/localAgentRuns.ts')>('../server/localAgentRuns.ts')

afterEach(() => {
  vi.clearAllMocks()
  mocks.accounts.mockResolvedValue([])
  mocks.catalog.mockReturnValue([])
})

const off = { enabled: false, model: 'default' }
const prefs = (devin: object = off, grok: object = off) => ({ devin, grok })

/* `devin models` as the shell reports it (acp.rs parse_devin_models) */
const DEVIN_CATALOG: AcpCatalogModel[] = [
  { id: 'adaptive', name: 'Adaptive', family: 'Adaptive' },
  { id: 'swe-2-high', name: 'SWE-2 High', family: 'SWE-2' },
  { id: 'swe-2-medium', name: 'SWE-2 Medium', family: 'SWE-2' },
  { id: 'swe-2-max', name: 'SWE-2 Max', family: 'SWE-2' },
  { id: 'swe-2-max-lightning', name: 'SWE-2 Max Lightning', family: 'SWE-2' },
  { id: 'gpt-6-sol-low', name: 'GPT-6 Sol Low Thinking', family: 'GPT-6 Sol' },
  { id: 'gpt-6-sol-high', name: 'GPT-6 Sol High Thinking', family: 'GPT-6 Sol' },
  { id: 'gpt-6-sol-none', name: 'GPT-6 Sol No Thinking', family: 'GPT-6 Sol' },
]

describe('the ACP model menus', () => {
  it('folds Devin variants into families whose effort is a suffix', () => {
    const families = devinFamilies(DEVIN_CATALOG)
    const swe = families.find((f) => f.id === 'swe-2')
    expect(swe).toMatchObject({ name: 'SWE-2', efforts: ['medium', 'high', 'max'] })
    expect(families.find((f) => f.id === 'gpt-6-sol')).toMatchObject({ name: 'GPT-6 Sol', efforts: ['low', 'high'] })
    /* a suffix that is no effort is a model of its own, with no dial */
    expect(families.find((f) => f.id === 'swe-2-max-lightning')?.efforts).toEqual([])
    expect(families.find((f) => f.id === 'gpt-6-sol-none')?.efforts).toEqual([])
    expect(families.find((f) => f.id === 'adaptive')).toMatchObject({ name: 'Adaptive', efforts: [] })
    /* curated first, in their order */
    expect(families.slice(0, 2).map((f) => f.id)).toEqual(['default', 'swe-2'])
  })
  it('composes the Devin model id at the nearest effort step', () => {
    const families = devinFamilies(DEVIN_CATALOG)
    expect(devinModelId('swe-2', 'high', families)).toBe('swe-2-high')
    expect(devinModelId('swe-2', 'xhigh', families)).toBe('swe-2-max')
    expect(devinModelId('swe-2', 'low', families)).toBe('swe-2-medium')
    /* no pick: the family's middle step */
    expect(devinModelId('swe-2', undefined, families)).toBe('swe-2-high')
    expect(devinModelId('claude-opus-5-5', 'max', families)).toBe('claude-opus-5-5-max')
    expect(devinModelId('adaptive', 'max', families)).toBe('adaptive')
    /* a pinned variant id and the CLI's own default go through as they are */
    expect(devinModelId('swe-2-max-lightning', 'low', families)).toBe('swe-2-max-lightning')
    expect(devinModelId('default', 'high', families)).toBe('default')
    expect(acpRunArgs('devin', 'swe-2-flash', 'max')).toEqual({ model: 'swe-2-flash-max' })
  })
  it('lists Grok models curated first, the CLI extras after, with its effort as a flag', () => {
    const models = grokModels([
      { id: 'grok-4.7', name: 'grok-4.7' },
      { id: 'grok-5-preview', name: 'grok-5-preview' },
      { id: 'Bad Id', name: 'x' },
    ])
    expect(models.map((m) => m.id)).toEqual([
      'default',
      'grok-4.7',
      'grok-4.7-build-fast',
      'grok-4.6',
      'grok-5-preview',
    ])
    expect(acpMenu('grok').efforts.map((e) => e.id)).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(acpRunArgs('grok', 'grok-4.7', 'xhigh')).toEqual({ model: 'grok-4.7', effort: 'xhigh' })
    expect(acpRunArgs('grok', 'grok-4.7', 'max')).toEqual({ model: 'grok-4.7' })
    expect(acpMenu('devin').efforts.map((e) => e.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })
  it('keeps model ids to a shape that can never be a flag', () => {
    for (const ok of ['swe-2-high', 'grok-4.7', 'default', 'gpt_6']) expect(isAcpModel(ok)).toBe(true)
    for (const bad of ['', '-m', '--model', 'Grok', 'a b', 'x;y', 'a/b']) expect(isAcpModel(bad)).toBe(false)
  })
  it('names the runner kinds and keeps them apart from model accounts', () => {
    expect(RUNNER_NAMES['devin-local']).toBe('Devin (desktop)')
    expect(RUNNER_NAMES['grok-local']).toBe('Grok (desktop)')
    expect(isRunnerProvider('devin-local') && isRunnerProvider('grok-local')).toBe(true)
    expect(isLocalRunner('grok-local') && isLocalRunner('claude-local') && !isLocalRunner('chatgpt')).toBe(true)
    expect(parseRunnerPick({ provider: 'grok-local', model: 'grok-4.7', effort: 'high' })).toEqual({
      provider: 'grok-local',
      model: 'grok-4.7',
      effort: 'high',
    })
  })
})

describe('ACP usage', () => {
  it('reads the prompt usage and a USD cost, and nothing when the agent reported none', () => {
    expect(
      fromAcpUsage(
        {
          usage: { inputTokens: 120, cachedReadTokens: 20, outputTokens: 30, thoughtTokens: 5 },
          cost: { amount: 0.25, currency: 'USD' },
        },
        'grok-4.7',
      ),
    ).toEqual([
      {
        model: 'grok-4.7',
        inputTokens: 100,
        outputTokens: 35,
        cacheReadTokens: 20,
        cacheWriteTokens: 0,
        costUsd: 0.25,
      },
    ])
    expect(fromAcpUsage({ usage: null, cost: { amount: 3, currency: 'EUR' } }, 'swe-2-high')).toEqual([])
    expect(fromAcpUsage(undefined, 'x')).toEqual([])
  })
})

describe('the default with desktop agents', () => {
  const chatgpt = { kind: 'chatgpt', enabled: true } as ModelAccount
  it('honours a marked ACP agent while it is on, and falls back to it last', () => {
    expect(resolveDefault('grok-local', false, [chatgpt], ['grok-local'])).toBe('grok-local')
    expect(resolveDefault('grok-local', false, [chatgpt], [])).toBe('chatgpt')
    expect(resolveDefault(undefined, true, [chatgpt], ['devin-local'])).toBe('claude-local')
    expect(resolveDefault(undefined, false, [chatgpt], ['devin-local'])).toBe('chatgpt')
    expect(resolveDefault(undefined, false, [], ['devin-local', 'grok-local'])).toBe('devin-local')
  })
})

function harness(): LocalHarnessRequest {
  return {
    canvasId: 'canvas-a',
    prompt: 'Design a page',
    system: 'Use canvas tools',
    maxTurns: 24,
    tools: [
      { name: 'create_frame', input_schema: { type: 'object' } },
      { name: 'get_canvas', input_schema: { type: 'object' } },
    ],
    execute: async (block) => ({ type: 'tool_result', tool_use_id: block.id, content: 'ok' }),
  }
}

describe('the relay keyed by agent', () => {
  it('hands an ACP job only to that agent’s poll, with the tool names, and keeps Claude jobs unchanged', async () => {
    const runs: LocalAgentRuns = new RealRuns()
    const grok = runs.start('alice', { agent: 'grok', model: 'grok-4.7', effort: 'high' }, harness())
    const plan = runs.start('alice', { model: 'sonnet' }, harness())
    const claudeJob = runs.poll('alice', 'mac')!
    expect(claudeJob.agent).toBeUndefined()
    expect(claudeJob.tools).toBeUndefined()
    expect(runs.poll('alice', 'mac', Date.now(), 'devin')).toBeNull()
    const job = runs.poll('alice', 'mac', Date.now(), 'grok', [{ id: 'grok-4.6', name: 'grok-4.6' }])!
    expect(job).toMatchObject({
      agent: 'grok',
      model: 'grok-4.7',
      effort: 'high',
      tools: ['create_frame', 'get_canvas'],
    })
    expect(runs.online('alice', Date.now(), 'grok')).toBe(true)
    expect(runs.online('bob', Date.now(), 'grok')).toBe(false)
    expect(runs.catalog('alice', 'grok')).toEqual([{ id: 'grok-4.6', name: 'grok-4.6' }])
    /* stopping Grok leaves the Plan's run alone */
    await runs.cancel('alice', 'grok')
    expect(await grok).toEqual({ success: false, text: 'Local Grok run stopped.' })
    expect(runs.authorized(claudeJob.id, claudeJob.token)).toBeDefined()
    expect(await runs.finish(claudeJob.id, 'alice', 'mac', { success: true, text: 'Done' })).toBe(true)
    expect(await plan).toEqual({ success: true, text: 'Done' })
  })
})

describe('routing to a desktop agent', () => {
  const req = harness()
  it('runs a Grok pick with its model and effort, while that desktop is online', async () => {
    mocks.plan.mockResolvedValue(off)
    mocks.acp.mockResolvedValue(prefs(off, { enabled: true, model: 'grok-4.6' }))
    mocks.online.mockReturnValue(true)
    const model = await pickModel('alice', { provider: 'grok-local', model: 'grok-4.7', effort: 'xhigh' })
    expect(model).toMatchObject({ provider: 'grok-local', label: 'Grok (desktop) (grok-4.7, xhigh effort)' })
    void model?.runHarness?.(req)
    expect(mocks.start).toHaveBeenCalledWith('alice', { agent: 'grok', model: 'grok-4.7', effort: 'xhigh' }, req)
    expect(mocks.online).toHaveBeenCalledWith('alice', expect.any(Number), 'grok')
  })
  it('composes a Devin family and effort into one model id from the desktop’s catalog', async () => {
    mocks.plan.mockResolvedValue(off)
    mocks.acp.mockResolvedValue(prefs({ enabled: true, model: 'swe-2', effort: 'medium' }))
    mocks.online.mockReturnValue(true)
    mocks.catalog.mockReturnValue(DEVIN_CATALOG)
    const model = await pickModel('alice', { provider: 'devin-local', effort: 'xhigh' })
    void model?.runHarness?.(req)
    expect(mocks.start).toHaveBeenCalledWith('alice', { agent: 'devin', model: 'swe-2-max' }, req)
    /* no pick: the stored model and effort */
    const fallback = await pickModel('alice')
    expect(fallback?.label).toBe('Devin (desktop) (swe-2-medium)')
  })
  it('waits for the desktop rather than moving the work, and ignores a pick of an agent that is off', async () => {
    mocks.plan.mockResolvedValue(off)
    mocks.acp.mockResolvedValue(prefs({ enabled: true, model: 'default' }))
    mocks.accounts.mockResolvedValue([])
    mocks.online.mockReturnValue(false)
    expect(await pickModel('alice', { provider: 'devin-local' })).toBeNull()
    mocks.online.mockReturnValue(true)
    /* Grok is off: the pick falls to the default, which is Devin */
    expect((await pickModel('alice', { provider: 'grok-local' }))?.provider).toBe('devin-local')
  })
})

describe('listRunners with desktop agents', () => {
  it('lists each ACP agent that is on with its menu and the CLI’s extras', async () => {
    mocks.plan.mockResolvedValue(off)
    mocks.acp.mockResolvedValue(prefs({ enabled: true, model: 'swe-2', effort: 'high' }, off))
    mocks.online.mockReturnValue(true)
    mocks.catalog.mockReturnValue(DEVIN_CATALOG)
    const listed = await listRunners('alice')
    expect(listed.default).toBe('devin-local')
    expect(listed.runners.map((r) => r.provider)).toEqual(['devin-local'])
    const [devin] = listed.runners
    expect(devin).toMatchObject({ name: 'Devin (desktop)', online: true, model: 'swe-2', effort: 'high' })
    expect(devin?.models.map((m) => m.id)).toContain('adaptive')
    expect(devin?.efforts?.map((e) => e.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })
})
