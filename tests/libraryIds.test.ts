import { describe, expect, it } from 'vitest'
import {
  assignItemId,
  isItemId,
  isLegacyItemId,
  itemSlug,
  MAX_ITEM_ID,
  parentIdOf,
  parseItemId,
  splitFrameName,
} from '../shared/libraryIds'
import { names } from './libraryFixtures'

describe('splitFrameName', () => {
  it.each(names())('splits $name', ({ name, id, label }) => {
    expect(splitFrameName(name)).toEqual({ id, label })
  })
})

describe('the id grammar', () => {
  it('reads kind, source and slug', () => {
    expect(parseItemId('bk.scb-login')).toEqual({ kind: 'bk', source: 'scb', slug: 'login' })
    expect(parseItemId('cp.scb-login-button-passkey-dark')).toEqual({
      kind: 'cp',
      source: 'scb',
      slug: 'login-button-passkey-dark',
    })
    expect(parseItemId('rs.shadcnblocks')).toEqual({ kind: 'rs', source: '', slug: 'shadcnblocks' })
  })

  it('takes a source only when it is known, if sources are given', () => {
    expect(parseItemId('cp.login-screen', ['scb'])).toEqual({ kind: 'cp', source: '', slug: 'login-screen' })
    expect(parseItemId('cp.scb-login', ['scb'])).toEqual({ kind: 'cp', source: 'scb', slug: 'login' })
  })

  it('has no kind for a bare slug', () => {
    expect(parseItemId('photo-stack')).toEqual({ kind: '', source: '', slug: 'photo-stack' })
  })

  it('accepts AS-IMG-02 as a legacy id', () => {
    expect(isLegacyItemId('AS-IMG-02')).toBe(true)
    expect(isItemId('AS-IMG-02')).toBe(true)
    expect(parseItemId('AS-IMG-02')).toEqual({ kind: 'as', source: '', slug: 'img-02' })
    expect(isItemId('as-img-02')).toBe(true)
  })

  it('refuses what is not an id', () => {
    for (const bad of ['', 'Login screen', 'INDEX', 'Settings', 'cp.', '.cp', 'cp..x', 'cp.a_b', '§ x']) {
      expect(isItemId(bad), bad).toBe(false)
    }
  })

  it('refuses ids longer than 120 characters', () => {
    const long = 'cp.' + 'a'.repeat(MAX_ITEM_ID)
    expect(long.length).toBeGreaterThan(120)
    expect(isItemId(long)).toBe(false)
    expect(parseItemId(long)).toBeNull()
    expect(isItemId('cp.' + 'a'.repeat(117))).toBe(true)
  })
})

describe('parentIdOf', () => {
  it('picks the longest family prefixed by the id', () => {
    expect(parentIdOf('cp.scb-login-button-passkey-dark', ['cp.scb-login', 'cp.scb-login-button'])).toBe(
      'cp.scb-login-button',
    )
  })

  it('needs a hyphen after the family id', () => {
    expect(parentIdOf('cp.scb-loginx', ['cp.scb-login'])).toBeNull()
  })

  it('is never the id itself', () => {
    expect(parentIdOf('cp.scb-login', ['cp.scb-login'])).toBeNull()
  })

  it('matches legacy ids without case', () => {
    expect(parentIdOf('AS-IMG-02-B', ['as-img-02'])).toBe('as-img-02')
  })
})

describe('itemSlug', () => {
  it('folds a label into a slug', () => {
    expect(itemSlug('Login screen')).toBe('login-screen')
    expect(itemSlug('Écran · Connexion (2)')).toBe('ecran-connexion-2')
    expect(itemSlug('  ---  ')).toBe('')
  })
})

describe('assignItemId', () => {
  const taken = new Set(['cp.login-screen'])

  it('builds kind.source-slug, kind.slug or slug', () => {
    expect(assignItemId({ kind: 'cp', source: 'scb', label: 'OTP input' }, [], 'suffix')).toEqual({
      ok: true,
      id: 'cp.scb-otp-input',
      replaces: false,
    })
    expect(assignItemId({ kind: 'cp', source: '', label: 'OTP input' }, [], 'suffix')).toMatchObject({
      id: 'cp.otp-input',
    })
    expect(assignItemId({ kind: '', source: '', label: 'OTP input' }, [], 'suffix')).toMatchObject({
      id: 'otp-input',
    })
  })

  it('suffixes a collision', () => {
    expect(assignItemId({ kind: 'cp', source: '', label: 'Login screen' }, taken, 'suffix')).toEqual({
      ok: true,
      id: 'cp.login-screen-2',
      replaces: false,
    })
    const more = new Set([...taken, 'cp.login-screen-2'])
    expect(assignItemId({ kind: 'cp', source: '', label: 'Login screen' }, more, 'suffix')).toMatchObject({
      id: 'cp.login-screen-3',
    })
  })

  it('rejects a collision', () => {
    expect(assignItemId({ kind: 'cp', source: '', label: 'Login screen' }, taken, 'reject')).toEqual({
      ok: false,
      id: 'cp.login-screen',
      reason: 'collision',
    })
  })

  it('replaces on collision when asked', () => {
    expect(assignItemId({ kind: 'cp', source: '', label: 'Login screen' }, taken, 'replace')).toEqual({
      ok: true,
      id: 'cp.login-screen',
      replaces: true,
    })
  })

  it('refuses an empty label', () => {
    expect(assignItemId({ kind: 'cp', source: '', label: '§§' }, [], 'suffix')).toMatchObject({
      ok: false,
      reason: 'empty',
    })
  })

  it('keeps a long label inside the length limit', () => {
    const r = assignItemId({ kind: 'cp', source: 'scb', label: 'word '.repeat(60) }, [], 'suffix')
    expect(r.ok && r.id.length <= MAX_ITEM_ID && isItemId(r.id)).toBe(true)
  })
})
