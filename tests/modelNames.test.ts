import { describe, expect, it } from 'vitest'
import { openaiModelName } from '../shared/modelMenu'

/** Every menu writes an OpenAI model one way, whichever catalog named it. */
describe('openaiModelName', () => {
  it.each([
    ['gpt-6.1-sol', undefined, 'GPT-6.1 Sol'],
    ['gpt-5.6-terra', 'GPT-5.6 Terra', 'GPT-5.6 Terra'],
    ['gpt-6.1-sol', 'GPT-6.1-Sol', 'GPT-6.1 Sol'],
    ['gpt-5.6-codex-max', undefined, 'GPT-5.6 Codex Max'],
    ['gpt-6', undefined, 'GPT-6'],
    ['o4-mini', undefined, 'o4 Mini'],
    ['custom-thing', undefined, 'custom-thing'],
    ['gpt-6-astra', 'Astra (preview)', 'Astra (preview)'],
  ])('names %s (catalog: %s) as %s', (id, display, name) => {
    expect(openaiModelName(id, display)).toBe(name)
  })
})
