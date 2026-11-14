import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LIBRARY_RULES,
  describeRules,
  detectPreset,
  isIgnoredName,
  MAX_SELECTOR,
  nameMatches,
  parseLibraryRules,
  RULE_PRESETS,
  sectionCategory,
} from '../shared/libraryRules'
import { names } from './libraryFixtures'

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

describe('parseLibraryRules', () => {
  it('parses the defaults', () => {
    expect(parseLibraryRules(DEFAULT_LIBRARY_RULES)).toEqual({ ok: true, rules: DEFAULT_LIBRARY_RULES })
  })

  it('round-trips every preset', () => {
    for (const rules of Object.values(RULE_PRESETS)) {
      expect(parseLibraryRules(clone(rules))).toEqual({ ok: true, rules })
    }
  })

  it('drops unknown keys', () => {
    const raw = { ...clone(RULE_PRESETS.sheets), extra: 1, ids: { ...RULE_PRESETS.sheets.ids, nope: true } }
    const parsed = parseLibraryRules(raw)
    expect(parsed.ok && parsed.rules).toEqual(RULE_PRESETS.sheets)
  })

  it('refuses a selector over 200 characters, with its path', () => {
    const raw = clone(RULE_PRESETS.sheets)
    raw.detect.variants = { mode: 'selectors', cell: 'x'.repeat(MAX_SELECTOR + 1) }
    const parsed = parseLibraryRules(raw)
    expect(parsed.ok).toBe(false)
    expect(!parsed.ok && parsed.errors.map((e) => e.path)).toEqual(['detect.variants.cell'])
  })

  it('refuses an unknown enum value and a score out of range', () => {
    const raw = clone(RULE_PRESETS.blank) as unknown as Record<string, Record<string, unknown>>
    raw.ids!.onCollision = 'merge'
    raw.lint!.minScore = 140
    const parsed = parseLibraryRules(raw)
    expect(!parsed.ok && parsed.errors.map((e) => e.path).sort()).toEqual(['ids.onCollision', 'lint.minScore'])
  })
})

describe('name globs', () => {
  it('matches section and title frames', () => {
    expect(nameMatches('§ *', '§ Inputs A — Text fields & core inputs')).toBe(true)
    expect(nameMatches('§ *', 'bk.scb-login — x')).toBe(false)
    expect(nameMatches('* — title', '013 Inputs & forms · Checkboxes & choice cards — title')).toBe(true)
    expect(nameMatches('* — title', 'Title screen')).toBe(false)
    expect(nameMatches('INDEX*', 'INDEX — all domains & pages')).toBe(true)
  })

  it('reads a section category, dropping the letter after the domain', () => {
    expect(sectionCategory('§ * — {category}', '§ Inputs A — Text fields & core inputs')).toBe(
      'Inputs/Text fields & core inputs',
    )
    expect(sectionCategory('§ * — {category}', '§ Auth — Log in')).toBe('Auth/Log in')
    expect(sectionCategory('§ * — {category}', 'bk.scb-login — x')).toBeNull()
    expect(sectionCategory(null, '§ Auth — Log in')).toBeNull()
  })

  it('ignores names under the sheets preset', () => {
    expect(isIgnoredName(RULE_PRESETS.sheets, '§ Data A — Tables & lists')).toBe(true)
    expect(isIgnoredName(RULE_PRESETS.sheets, 'bk.scb-login — Login')).toBe(false)
    expect(isIgnoredName(RULE_PRESETS.blank, '§ Data A — Tables & lists')).toBe(false)
  })
})

describe('detectPreset', () => {
  it('picks sheets for the live names', () => {
    expect(detectPreset(names().map((n) => n.name))).toBe('sheets')
  })

  it('picks blank for plain names', () => {
    const plain = ['Home', 'Pricing', 'Login', 'Sign up', 'Settings', 'Profile', 'Dashboard', 'Inbox', 'Help', 'About']
    expect(detectPreset(plain)).toBe('blank')
    expect(detectPreset([])).toBe('blank')
  })
})

describe('describeRules', () => {
  it('says the rules in plain words', () => {
    const lines = describeRules(RULE_PRESETS.sheets)
    expect(lines.some((l) => l.includes('<id> — <label>'))).toBe(true)
    expect(lines.some((l) => l.startsWith('Quality gate'))).toBe(true)
    expect(describeRules(RULE_PRESETS.blank).some((l) => l.startsWith('Quality gate'))).toBe(false)
  })
})
