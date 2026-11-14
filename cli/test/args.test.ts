import { describe, expect, it } from 'vitest'
import { parseDoopRef, parseInvocation, UsageError } from '../src/args.ts'

describe('parseInvocation', () => {
  it('defaults to help with no arguments', () => {
    expect(parseInvocation([]).command).toBe('help')
  })

  it('reads the command, its argument and flags in any order', () => {
    const inv = parseInvocation(['--url', 'https://doop.test', 'link', 'abc123', '-y'])
    expect(inv.command).toBe('link')
    expect(inv.args).toEqual(['abc123'])
    expect(inv.flags.url).toBe('https://doop.test')
    expect(inv.flags.yes).toBe(true)
    expect(inv.flags.force).toBe(false)
  })

  it('accepts --flag=value', () => {
    expect(parseInvocation(['open', '--canvas=xyz']).flags.canvas).toBe('xyz')
  })

  it('rejects unknown commands and flags', () => {
    expect(() => parseInvocation(['deploy'])).toThrow(UsageError)
    expect(() => parseInvocation(['open', '--bogus'])).toThrow(UsageError)
  })

  it('checks how many arguments a command takes', () => {
    expect(() => parseInvocation(['link'])).toThrow(/missing argument/)
    expect(() => parseInvocation(['link', 'a', 'b'])).toThrow(/too many/)
  })

  it('lets --help through whatever the arguments', () => {
    expect(parseInvocation(['link', '--help']).flags.help).toBe(true)
  })

  it('validates --limit', () => {
    expect(() => parseInvocation(['open', '--limit', '0'])).toThrow(/limit/)
    expect(() => parseInvocation(['open', '--limit', 'ten'])).toThrow(/limit/)
    expect(parseInvocation(['open', '-n', '20']).flags.limit).toBe(20)
  })

  it('only knows mcp install', () => {
    expect(() => parseInvocation(['mcp', 'remove'])).toThrow(/mcp install/)
  })
})

describe('parseDoopRef', () => {
  it('reads a canvas link and its frame', () => {
    expect(parseDoopRef('https://doop.test:8850/c/can_1?frame=fr_2&element=x')).toEqual({
      canvas: 'can_1',
      frame: 'fr_2',
    })
    expect(parseDoopRef('/c/can_1')).toEqual({ canvas: 'can_1' })
  })

  it('takes a bare id as either kind', () => {
    expect(parseDoopRef(' 4g71OAsbO_ ')).toEqual({ canvas: '4g71OAsbO_', frame: '4g71OAsbO_' })
  })

  it('refuses anything else', () => {
    expect(() => parseDoopRef('not an id')).toThrow(UsageError)
  })
})
