import type { RunnerProvider } from '../../shared/agentRunner'
import type { AppIconBrand, Brand } from '../components/ui/brand-mark'

/** The bare brand mark each connection's models wear in a compact menu. */
export const RUNNER_BRAND: Partial<Record<RunnerProvider, Brand>> = {
  'claude-local': 'claude',
  'devin-local': 'devin',
  'grok-local': 'grok',
  'anthropic-key': 'claude',
  chatgpt: 'openai',
  'openai-key': 'openai',
  'gemini-key': 'gemini',
  'openrouter-key': 'openrouter',
  'deepseek-key': 'deepseek',
  'kimi-key': 'kimi',
  'kimi-code': 'kimi',
}

/** The app tile a connection wears where it heads a list, as Settings draws it. */
export const RUNNER_APP_ICON: Partial<Record<RunnerProvider, AppIconBrand>> = {
  'claude-local': 'claude-code',
  'devin-local': 'devin',
  'grok-local': 'grok',
  'anthropic-key': 'claude',
  chatgpt: 'openai',
  'openai-key': 'openai',
  'gemini-key': 'gemini',
  'openrouter-key': 'openrouter',
  'deepseek-key': 'deepseek',
  'kimi-key': 'kimi',
  'kimi-code': 'kimi',
}
