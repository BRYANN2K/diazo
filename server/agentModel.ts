import { env } from './env.ts'
import packageJson from '../package.json' with { type: 'json' }
import { DESCRIBER_ANTHROPIC_MODEL, DESCRIBER_MODELS } from '../shared/modelMenu.ts'
import { readConnections, usableAccount, type Connections } from './agentDefaults.ts'
import { geminiCloudRuns, geminiCloudWorkerFor } from './geminiCloudRuns.ts'
import { localAgentRuns, type LocalHarnessRequest } from './localAgentRuns.ts'
import { isClaudeEffort, isClaudeModel, type LocalAgentResult } from '../shared/localAgent.ts'
import type { RunnerPick } from '../shared/agentRunner.ts'
import {
  ACP_AGENT_NAMES,
  acpAgentOf,
  acpRunArgs,
  isAcpEffort,
  isAcpModel,
  isAcpRunnerProvider,
  type AcpRunnerProvider,
} from '../shared/acpAgent.ts'
import { fromAnthropicUsage, type TokenUsage } from '../shared/usage.ts'
import Anthropic from '@anthropic-ai/sdk'
import { withFreshToken, accountModelFor, accountVisionFor, accountWithPick, customModelFor } from './modelAccounts.ts'
import type { AccountKind, BuiltinAccountKind, ModelAccount } from './modelAccounts.ts'
import { customProviderFetch } from './customProviderFetch.ts'
import { personAnthropicClient } from './personAnthropicClient.ts'
import { isCustomProviderKind, type CustomModel, type CustomProviderConfig } from '../shared/customProvider.ts'
import { ModelAuthError, ModelUnavailableError, effortFor, runAzureTurn, runOpenAiTurn } from './openaiAgent.ts'
import type { StopReason, TurnBlock } from './openaiAgent.ts'
import {
  IMAGE_OMITTED_NOTE,
  deepseekConfig,
  geminiConfig,
  kimiCodeConfig,
  kimiConfig,
  openrouterConfig,
  runChatCompletionsTurn,
  type ChatCompletionsConfig,
} from './chatCompletionsAgent.ts'

/**
 * Which model runs a Doop Agent turn, and on whose bill.
 *
 * Two layers, resolved in this order:
 *
 *  - a user's own model account (their ChatGPT subscription or an OpenAI API
 *    key) — the moment one is connected, that user's runs move onto it and
 *    the free-task meter stops applying to them;
 *  - the server tier, which pays for the free tasks every account starts
 *    with. DOOP_AGENT_PROVIDER picks what it runs on: 'anthropic' (the
 *    default, on ANTHROPIC_API_KEY) or 'azure' (the AZURE_OPENAI_* vars).
 *
 * A run bills exactly ONE person: the requester behind the work it claims. The
 * queue is worked one requester at a time rather than sweeping several people's
 * cards into a single call, so nobody's subscription ever pays for someone
 * else's request.
 */

export type ServerProvider = 'anthropic' | 'azure'
export type Provider = ServerProvider | AccountKind | 'claude-local' | AcpRunnerProvider | 'gemini-cloud'

export interface AgentTurnRequest {
  /** ordered system blocks; `cache` marks an Anthropic cache breakpoint */
  system: { text: string; cache?: boolean }[]
  tools: Anthropic.Tool[]
  messages: Anthropic.MessageParam[]
  maxTokens: number
  /** aborts the turn mid-generation: the run's work was stopped */
  signal?: AbortSignal
}

export interface AgentTurnResult {
  content: TurnBlock[]
  stop_reason: StopReason
  /** what the turn consumed, for the usage meter (shared/usage.ts) */
  usage?: TokenUsage
}

export interface AgentModel {
  provider: Provider
  /** for logs and the canvas status line, e.g. "ChatGPT (gpt-5)" */
  label: string
  /** the user whose account pays, when it isn't the server's key */
  userId?: string
  /** false = the model cannot see images and the run degrades to no visual
   *  review; absent means true (every pre-roster provider has vision) */
  vision?: boolean
  runHarness?: (req: LocalHarnessRequest) => Promise<LocalAgentResult>
  run(req: AgentTurnRequest): Promise<AgentTurnResult>
}

export { ModelAuthError, ModelUnavailableError }
export class ModelConfigurationError extends ModelAuthError {}

/* ---------------------------------------------------------------- */
/* the server tier: pays for everyone's free tasks                  */
/* ---------------------------------------------------------------- */

const ANTHROPIC_MODEL = env.DOOP_AGENT_MODEL

let anthropic: Anthropic | null = null

function anthropicTier(model: string = ANTHROPIC_MODEL): AgentModel | null {
  if (!env.ANTHROPIC_API_KEY) {
    warnOnce(
      '[doop-agent] ANTHROPIC_API_KEY not set — the free Diazo Agent tier is off. Users who connect a model account of their own still get the agent; everyone else sees queued cards and @mentions go unpicked. See docs/doop-reference.md → "The Diazo Agent".',
    )
    return null
  }
  if (!anthropic) anthropic = new Anthropic()
  const client = anthropic
  return {
    provider: 'anthropic',
    label: `Diazo (${model})`,
    run: (req) => runAnthropicTurn(client, model, req),
  }
}

/**
 * One Anthropic turn, streamed and collected into a message.
 *
 * Streaming is not for show here: it is what lets a turn run long. The SDK
 * refuses a non-streaming request whose max_tokens implies more than ten
 * minutes of generation ("Streaming is required for operations that may take
 * longer than 10 minutes"), and GitHub recon asks for 32k tokens per turn. A
 * bigger client timeout would silence that check but leave a silent HTTP
 * connection open for the whole generation, which proxies drop. Over SSE the
 * SDK's timeout only guards the wait for headers; the response itself stays
 * alive on the API's ping events until the message is complete.
 */
export async function runAnthropicTurn(
  client: Anthropic,
  model: string,
  req: AgentTurnRequest,
): Promise<AgentTurnResult> {
  const res = await client.messages
    .stream(
      {
        model,
        max_tokens: req.maxTokens,
        system: req.system.map((block) => ({
          type: 'text' as const,
          text: block.text,
          ...(block.cache ? { cache_control: { type: 'ephemeral' as const } } : {}),
        })),
        tools: req.tools,
        messages: req.messages,
      },
      { signal: req.signal },
    )
    .finalMessage()
  const stop: StopReason =
    res.stop_reason === 'refusal'
      ? 'refusal'
      : res.stop_reason === 'max_tokens'
        ? 'max_tokens'
        : res.stop_reason === 'tool_use'
          ? 'tool_use'
          : 'end_turn'
  return {
    content: res.content as TurnBlock[],
    stop_reason: stop,
    ...(res.usage ? { usage: fromAnthropicUsage(res.model || model, res.usage) } : {}),
  }
}

function azureTier(): AgentModel | null {
  const endpoint = env.AZURE_OPENAI_ENDPOINT
  const deployment = env.AZURE_OPENAI_DEPLOYMENT
  const apiKey = env.AZURE_OPENAI_API_KEY
  if (!endpoint || !deployment || !apiKey) {
    warnOnce(
      '[doop-agent] DOOP_AGENT_PROVIDER=azure needs AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_DEPLOYMENT and AZURE_OPENAI_API_KEY — the free Diazo Agent tier is off until all three are set.',
    )
    return null
  }
  const config = { endpoint, deployment, apiKey }
  return {
    provider: 'azure',
    label: `Diazo (${deployment})`,
    async run(req) {
      try {
        return await runAzureTurn(config, {
          system: joinSystem(req),
          tools: req.tools,
          messages: req.messages,
          maxTokens: req.maxTokens,
          signal: req.signal,
        })
      } catch (err) {
        /* these are the SERVER's credentials — "reconnect your account" would
           send users chasing a connection they don't have */
        if (err instanceof ModelAuthError) {
          throw new Error(
            'Azure OpenAI rejected this server’s credentials — check AZURE_OPENAI_API_KEY and AZURE_OPENAI_DEPLOYMENT',
            { cause: err },
          )
        }
        throw err
      }
    },
  }
}

const serverTiers: Record<ServerProvider, () => AgentModel | null> = {
  anthropic: anthropicTier,
  azure: azureTier,
}

/* an unknown DOOP_AGENT_PROVIDER fails at boot (server/env.ts) */
function serverProvider(): ServerProvider {
  return env.DOOP_AGENT_PROVIDER
}

/** What the boot banner reports: which provider the free tier would run on,
 *  and whether it actually can. */
export function serverTierInfo(): { provider: ServerProvider; ready: boolean } {
  const provider = serverProvider()
  return { provider, ready: serverTiers[provider]() !== null }
}

const warnedAbout = new Set<string>()
function warnOnce(message: string) {
  if (warnedAbout.has(message)) return
  warnedAbout.add(message)
  console.log(message)
}

/* ---------------------------------------------------------------- */
/* a user's own account                                             */
/* ---------------------------------------------------------------- */

const BYO_LABELS: Record<BuiltinAccountKind, string> = {
  chatgpt: 'ChatGPT',
  'openai-key': 'OpenAI',
  'anthropic-key': 'Claude API',
  'openrouter-key': 'OpenRouter',
  'gemini-key': 'Gemini',
  'deepseek-key': 'DeepSeek',
  'kimi-key': 'Kimi',
  'kimi-code': 'Kimi Code',
  'elevenlabs-key': 'ElevenLabs',
}

/* the account kinds that run on the Chat Completions transport */
const CHAT_COMPLETIONS_CONFIGS: Partial<
  Record<BuiltinAccountKind, (apiKey: string, model: string, vision: boolean) => ChatCompletionsConfig>
> = {
  'openrouter-key': openrouterConfig,
  'gemini-key': geminiConfig,
  'deepseek-key': deepseekConfig,
  'kimi-key': kimiConfig,
  'kimi-code': kimiCodeConfig,
}

/* the OpenAI-shaped transports take one system string; cache breakpoints are
   an Anthropic concept and simply flatten away */
function joinSystem(req: AgentTurnRequest): string {
  return req.system.map((block) => block.text).join('\n\n')
}

/* ---------------------------------------------------------------- */
/* a custom provider: an endpoint its person named                  */
/* ---------------------------------------------------------------- */

/** Where a custom provider's turns go and with what credentials. */
export interface CustomTarget {
  config: CustomProviderConfig
  apiKey?: string
  headers?: Record<string, string>
}

/* the SDK sets these on every request itself: an env line naming one is
   nulled like every other and a fixed value goes out instead — the operator's
   gateway User-Agent is not a custom endpoint's business, and a strict
   gateway still gets the anthropic-version it needs to answer */
const SDK_OWN_HEADERS: Record<string, string> = {
  'anthropic-version': '2023-06-01',
  Accept: 'application/json',
  'User-Agent': `Diazo/${packageJson.version}`,
}

/**
 * The header names ANTHROPIC_CUSTOM_HEADERS parses to, each nulled. The SDK
 * merges that variable into every client's headers, where the server's own
 * values would ride along to a custom endpoint; nulls in defaultHeaders take
 * them back out — the SDK's own names too, whose fixed values are restated
 * after these. The endpoint's own headers spread last still win.
 */
function envHeaderNulls(): Record<string, null> {
  const nulls: Record<string, null> = {}
  for (const line of (env.ANTHROPIC_CUSTOM_HEADERS ?? '').split('\n')) {
    const colon = line.indexOf(':')
    const name = colon >= 0 ? line.slice(0, colon).trim() : ''
    if (name) nulls[name] = null
  }
  return nulls
}

/**
 * One turn on a custom provider's model, over the API type its person
 * picked. Every request goes through customProviderFetch (public addresses
 * only, DNS pinned, no redirects), and the output budget is held to what the
 * model was said to allow.
 */
export function customTurn(target: CustomTarget, model: CustomModel): AgentModel['run'] {
  const { config, apiKey, headers = {} } = target
  const budget = (req: AgentTurnRequest) => Math.min(req.maxTokens, model.maxOutputTokens ?? req.maxTokens)
  if (config.apiType === 'anthropic') {
    const client = new Anthropic({
      /* the person's key, or a sentinel when they gave none: a null key makes
         the SDK resolve this machine's own Anthropic credentials (env vars,
         ~/.config/anthropic profiles) and send them to the endpoint */
      apiKey: apiKey || 'custom-provider',
      /* ANTHROPIC_AUTH_TOKEN from the server's environment is not theirs */
      authToken: null,
      baseURL: config.baseUrl,
      fetch: customProviderFetch,
      defaultHeaders: {
        /* the server's env headers must not reach an endpoint a person named */
        ...envHeaderNulls(),
        /* the nulls strip the SDK's own headers along with the env's; fixed
           values go back in their place */
        ...SDK_OWN_HEADERS,
        /* without a key, drop the sentinel's header explicitly or the SDK
           refuses to send anything; with one, restate it so an env X-Api-Key
           cannot smuggle the server's in */
        ...(apiKey ? { 'X-Api-Key': apiKey } : { 'X-Api-Key': null }),
        /* the person's own headers win over all of it */
        ...headers,
      },
    })
    return async (req) => {
      try {
        return await runAnthropicTurn(client, model.id, {
          ...req,
          messages: model.vision ? req.messages : withoutImages(req.messages),
          maxTokens: budget(req),
        })
      } catch (error) {
        if (error instanceof Anthropic.APIError && (error.status === 401 || error.status === 403)) {
          throw new ModelAuthError(`${config.name} rejected the API key. Update it in Settings.`)
        }
        throw error
      }
    }
  }
  const chat: ChatCompletionsConfig = {
    url: `${config.baseUrl}/chat/completions`,
    headers: { ...headers, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    model: model.id,
    label: config.name,
    vision: model.vision,
    ...(config.echoReasoning ? { echoReasoning: true } : {}),
    ...(config.tokenParam ? { tokenParam: config.tokenParam } : {}),
    fetch: customProviderFetch,
  }
  return (req) =>
    runChatCompletionsTurn(chat, {
      system: joinSystem(req),
      tools: req.tools,
      messages: req.messages,
      maxTokens: budget(req),
      signal: req.signal,
    })
}

/**
 * The conversation with every image, top-level or inside a tool result,
 * swapped for the text note the Chat Completions transport uses: a model said
 * not to see images must not be sent any, whichever tool produced them.
 */
export function withoutImages(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const note = { type: 'text' as const, text: IMAGE_OMITTED_NOTE }
  return messages.map((message) => {
    if (typeof message.content === 'string') return message
    return {
      ...message,
      content: message.content.map((block) => {
        if (block.type === 'image') return note
        if (block.type === 'tool_result' && Array.isArray(block.content)) {
          return { ...block, content: block.content.map((part) => (part.type === 'image' ? note : part)) }
        }
        return block
      }),
    }
  })
}

function customModel(account: ModelAccount): AgentModel {
  const config = account.custom
  const model = customModelFor(account)
  if (!config || !model) throw new ModelConfigurationError('Add a model to this custom provider in Settings.')
  return {
    provider: account.kind,
    label: `${config.name} (${model.id})`,
    userId: account.userId,
    vision: model.vision,
    run: customTurn(
      {
        config,
        ...(account.apiKey ? { apiKey: account.apiKey } : {}),
        ...(account.headers ? { headers: account.headers } : {}),
      },
      model,
    ),
  }
}

function byoModel(account: ModelAccount): AgentModel {
  const kind = account.kind
  if (kind === 'elevenlabs-key') throw new ModelConfigurationError('Voice connections cannot run canvas tasks.')
  if (isCustomProviderKind(kind)) return customModel(account)
  if (kind === 'anthropic-key') {
    if (!account.apiKey) throw new ModelAuthError('Reconnect your Claude API key in Settings.')
    const client = personAnthropicClient(account.apiKey)
    const model = accountModelFor(account)
    return {
      provider: account.kind,
      label: `Claude API (${model})`,
      userId: account.userId,
      async run(req) {
        try {
          return await runAnthropicTurn(client, model, req)
        } catch (error) {
          if (
            error instanceof Anthropic.APIError &&
            (error.status === 400 || error.status === 404) &&
            /anthropic-workspace-id|workspace/i.test(error.message)
          ) {
            throw new ModelConfigurationError(
              'Create an Anthropic API key scoped to one workspace, then use Rotate key in Settings → Claude API key and retry.',
            )
          }
          if (error instanceof Anthropic.APIError && (error.status === 401 || error.status === 403)) {
            throw new ModelAuthError('Anthropic rejected your API key. Reconnect it in Settings.')
          }
          throw error
        }
      },
    }
  }
  const chatCompletionsConfig = CHAT_COMPLETIONS_CONFIGS[kind]
  if (chatCompletionsConfig) {
    if (!account.apiKey) throw new ModelAuthError(`Reconnect your ${BYO_LABELS[kind]} key in Settings.`)
    const model = accountModelFor(account)
    const vision = accountVisionFor(account)
    const config = chatCompletionsConfig(account.apiKey, model, vision)
    return {
      provider: account.kind,
      label: `${BYO_LABELS[kind]} (${model})`,
      userId: account.userId,
      vision,
      run: (req) =>
        runChatCompletionsTurn(config, {
          system: joinSystem(req),
          tools: req.tools,
          messages: req.messages,
          maxTokens: req.maxTokens,
          signal: req.signal,
        }),
    }
  }
  return {
    provider: account.kind,
    label: `${BYO_LABELS[kind]} (${accountModelFor(account)}, ${effortFor(account)} effort)`,
    userId: account.userId,
    async run(req) {
      /* refreshed per turn, not per run: a long design run outlives an
         hour-long access token */
      const live = await withFreshToken(account)
      return runOpenAiTurn(live, {
        system: joinSystem(req),
        tools: req.tools,
        messages: req.messages,
        maxTokens: req.maxTokens,
        signal: req.signal,
      })
    },
  }
}

/**
 * Pick the model for one run, billed to exactly one person: `payerId` is the
 * human whose work the run is about to claim. Returns null when nothing can
 * run it — they have no account of their own and the server tier is off.
 *
 * A connected account wins outright: someone who has just linked their own
 * subscription expects the very next task to run on it, and the free tier is a
 * trial to get them here, not a balance to spend down first. It also means
 * connecting stops costing us anything from that moment on.
 *
 * `pick` is what the card asked for (the composer's choice): one of the
 * person's connections — the Claude Plan on their desktop or one of their
 * model accounts — and the model and effort on it. Work without a pick (a
 * comment, an automation), or with one naming a connection that is gone or
 * switched off, runs on their default (agentDefaults.ts).
 */
export async function pickModel(payerId?: string, pick?: RunnerPick): Promise<AgentModel | null> {
  if (!payerId) return serverTiers[serverProvider()]()
  const worker = geminiCloudWorkerFor(payerId)
  if (worker) {
    return {
      provider: 'gemini-cloud',
      label: 'Gemini CLI (cloud pilot)',
      userId: payerId,
      runHarness: (req) => geminiCloudRuns.start(payerId, worker, req),
      run: () =>
        Promise.reject(
          new Error('Gemini cloud pilot supports canvas tasks only. Repository imports require a server provider.'),
        ),
    }
  }
  const connections = await readConnections(payerId).catch((err): Connections => {
    console.error('[doop-agent] could not read the connected model accounts', err)
    return { plan: { enabled: false, model: 'default' }, accounts: [], default: undefined }
  })
  const picked =
    pick &&
    (pick.provider === 'claude-local'
      ? connections.plan.enabled
      : isAcpRunnerProvider(pick.provider)
        ? !!connections.acp?.[acpAgentOf(pick.provider)].enabled
        : usableAccount(connections, pick.provider))
  const provider = picked ? pick.provider : connections.default
  /* the pick's model and effort apply only to the connection it named */
  const own = picked ? pick : undefined
  if (provider === 'claude-local') {
    /* the Plan never hands its work to another connection while the desktop is away */
    if (!localAgentRuns.online(payerId)) return null
    const plan = connections.plan
    const run = {
      model: own && isClaudeModel(own.model) ? own.model : plan.model,
      effort: own && isClaudeEffort(own.effort) ? own.effort : plan.effort,
    }
    return {
      provider: 'claude-local',
      label: `Claude CLI (${run.model}${run.effort ? `, ${run.effort} effort` : ''})`,
      userId: payerId,
      runHarness: (req) => localAgentRuns.start(payerId, run, req),
      run: () =>
        Promise.reject(
          new Error('Repository imports require a server provider. Select your connected account in Settings.'),
        ),
    }
  }
  if (isAcpRunnerProvider(provider)) {
    const agent = acpAgentOf(provider)
    const preference = connections.acp?.[agent]
    /* like the Plan: the work waits for this desktop rather than moving */
    if (!preference?.enabled || !localAgentRuns.online(payerId, Date.now(), agent)) return null
    const model = own && isAcpModel(own.model) ? own.model : preference.model
    const effort = own && isAcpEffort(agent, own.effort) ? own.effort : preference.effort
    const run = acpRunArgs(agent, model, effort, localAgentRuns.catalog(payerId, agent))
    return {
      provider,
      label: `${ACP_AGENT_NAMES[agent]} (${run.model}${run.effort ? `, ${run.effort} effort` : ''})`,
      userId: payerId,
      runHarness: (req) => localAgentRuns.start(payerId, { agent, ...run }, req),
      run: () =>
        Promise.reject(
          new Error('Repository imports require a server provider. Select your connected account in Settings.'),
        ),
    }
  }
  const account = usableAccount(connections, provider)
  if (account) return byoModel(accountWithPick(account, own))
  return serverTiers[serverProvider()]()
}

/**
 * The models a background library job runs on (server/libraryCuration.ts),
 * always on the payer's OWN connected account, never the server tier: such
 * a job makes a hundred calls nobody watches, so it must not spend the free
 * tasks. `main` is the account's configured model (judgement: proposing a
 * category tree); `bulk` its small tier where it has one (filing thousands of
 * items). The person's default connection is used when it runs turns, else
 * the first account that is on (the Claude Plan on the desktop runs whole
 * harness tasks only). Null when they have no account that can.
 */
export async function accountTurnModels(payerId: string): Promise<{ main: AgentModel; bulk: AgentModel } | null> {
  const connections = await readConnections(payerId)
  const account =
    usableAccount(connections, connections.default) ??
    connections.accounts.find((a) => a.enabled && a.kind !== 'elevenlabs-key') ??
    null
  if (!account) return null
  const main = byoModel(account)
  return { main, bulk: accountDescriber(account) ?? main }
}

/* ---------------------------------------------------------------- */
/* image descriptions: a small tier, never the design model          */
/* ---------------------------------------------------------------- */

/**
 * The model that describes an uploaded image on a user's own account
 * (shared/imageDescriptions.ts): the provider's small vision tier from
 * DESCRIBER_MODELS, or the account's own model at low reasoning effort where
 * the provider's roster is per subscription. Null when the account's model
 * cannot see images — the caller falls through to the server tier.
 */
export function accountDescriber(account: ModelAccount): AgentModel | null {
  const small: ModelAccount = {
    ...account,
    model: DESCRIBER_MODELS[account.kind] ?? account.model,
    effort: 'low',
  }
  if (!accountVisionFor(small)) return null
  return byoModel(small)
}

/** The server tier's describer: Haiku on the Anthropic key, the one
 *  deployment on Azure. Null when the free tier is off. */
export function serverDescriber(provider: ServerProvider = serverProvider()): AgentModel | null {
  return provider === 'anthropic' ? anthropicTier(DESCRIBER_ANTHROPIC_MODEL) : azureTier()
}
