import { describe, expect, it } from 'vitest'
import {
  CLAUDE_MODELS,
  CLAUDE_MODEL_ALIASES,
  CLAUDE_PINNED_MODELS,
  CLAUDE_PLAN_MODELS,
  isClaudeAlias,
  isClaudeEffort,
  isClaudeModel,
  normalizeClaudeModel,
} from '../shared/localAgent'

/**
 * Claude Code on the desktop runs whatever `--model` names. The menu is the
 * CLI's aliases, which follow new releases on their own, and a pinned id is
 * accepted by shape; the shell checks the same rule again (claude.rs
 * valid_model) before the value becomes an argument.
 */
describe('Claude model preferences', () => {
  it('offers every alias, and nothing else, on the menu', () => {
    expect(CLAUDE_MODELS.map((model) => model.id).sort()).toEqual([...CLAUDE_MODEL_ALIASES].sort())
  })

  it.each([...CLAUDE_MODEL_ALIASES])('runs the alias %s as itself', (alias) => {
    expect(normalizeClaudeModel(alias)).toBe(alias)
  })

  it.each([
    'claude-fable-5-1',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-haiku-4-5-20251001',
    'claude-opus-5-20260901',
  ])('keeps a pinned id %s, including ones saved before the aliases', (id) => {
    expect(isClaudeModel(id)).toBe(true)
    expect(normalizeClaudeModel(id)).toBe(id)
  })

  it.each([
    undefined,
    null,
    '',
    'unknown-model',
    'gpt-6',
    'claude-',
    'claude-Opus',
    'claude-opus 5',
    '--model',
    'claude-x'.padEnd(120, 'x'),
  ])('falls back to the default for %s', (saved) => {
    expect(isClaudeModel(saved)).toBe(false)
    expect(normalizeClaudeModel(saved)).toBe('sonnet')
  })

  it('knows the CLI effort levels and nothing else', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) expect(isClaudeEffort(level)).toBe(true)
    for (const level of ['default', '', 'HIGH', 'none', 3, undefined]) expect(isClaudeEffort(level)).toBe(false)
  })
})

describe('the Claude Plan menu', () => {
  it('offers the aliases first, then every pinned model, each one a valid --model', () => {
    const ids = CLAUDE_PLAN_MODELS.map((model) => model.id)
    expect(ids.slice(0, CLAUDE_MODEL_ALIASES.length).sort()).toEqual([...CLAUDE_MODEL_ALIASES].sort())
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(isClaudeModel(id)).toBe(true)
    for (const model of CLAUDE_PINNED_MODELS) expect(isClaudeAlias(model.id)).toBe(false)
  })

  it('pins the current generation and the earlier ones still served, by name and version', () => {
    expect(CLAUDE_PINNED_MODELS.map((model) => model.id)).toEqual(
      expect.arrayContaining([
        'claude-fable-5-2',
        'claude-opus-5-5',
        'claude-sonnet-5-5',
        'claude-haiku-5-5',
        'claude-fable-5-1',
        'claude-opus-5',
        'claude-sonnet-5',
        'claude-haiku-4-5',
      ]),
    )
    expect(CLAUDE_PINNED_MODELS.find((model) => model.id === 'claude-opus-5-5')?.name).toBe('Opus 5.5')
    /* an alias reads as the newest of its family */
    expect(CLAUDE_MODELS.find((model) => model.id === 'opus')?.name).toBe('Latest Opus')
  })
})
