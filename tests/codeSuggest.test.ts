import { describe, expect, it } from 'vitest'
import { codeNameCandidates, exportSearchPattern, rankCodeSuggestions } from '../shared/codeSuggest.ts'

describe('codeNameCandidates', () => {
  it('PascalCases the name and its base', () => {
    expect(codeNameCandidates('Pricing Card', 'component')).toEqual(['PricingCard'])
    expect(codeNameCandidates('pricing-card', 'component')).toEqual(['PricingCard'])
    expect(codeNameCandidates('Écran Panier — mobile', 'component')).toEqual(['EcranPanierMobile', 'EcranPanier'])
  })

  it('tries page and screen suffixes for frames', () => {
    expect(codeNameCandidates('Pricing', 'frame')).toEqual(['Pricing', 'PricingPage', 'PricingScreen'])
    expect(codeNameCandidates('Settings Page', 'frame')).toEqual(['SettingsPage'])
  })

  it('drops names that cannot be identifiers', () => {
    expect(codeNameCandidates('—', 'component')).toEqual([])
    expect(codeNameCandidates('404', 'component')).toEqual([])
  })
})

describe('exportSearchPattern', () => {
  it('matches the declarations the search should find', () => {
    const re = new RegExp(exportSearchPattern(['Button', 'Card']))
    expect(re.test('export function Button() {')).toBe(true)
    expect(re.test('export default async function Card(props) {')).toBe(true)
    expect(re.test('export const Button = forwardRef(')).toBe(true)
    expect(re.test('export const ButtonGroup = 1')).toBe(false)
    expect(re.test('function Button() {}')).toBe(false)
  })
})

describe('rankCodeSuggestions', () => {
  const candidates = ['PricingCard']

  it('ranks export-in-a-named-file over a declaration elsewhere over a file name alone', () => {
    const suggestions = rankCodeSuggestions(
      candidates,
      [
        { path: 'src/components/PricingCard.tsx', line: 3, text: 'export function PricingCard({ plan }) {' },
        { path: 'src/legacy/cards.tsx', line: 40, text: 'export const PricingCard = () => null' },
      ],
      [
        { path: 'src/components/PricingCard.tsx', kind: 'file', size: 900 },
        { path: 'src/components/pricing-card.astro', kind: 'file', size: 400 },
        { path: 'src/components', kind: 'dir' },
      ],
    )
    expect(suggestions.map((s) => [s.path, s.reason, s.exportName])).toEqual([
      ['src/components/PricingCard.tsx', 'export+file', 'PricingCard'],
      ['src/legacy/cards.tsx', 'export', 'PricingCard'],
      ['src/components/pricing-card.astro', 'file', 'default'],
    ])
    expect(suggestions[0]!.line).toBe(3)
  })

  it('maps a default export as default and reads folder index files', () => {
    const suggestions = rankCodeSuggestions(
      candidates,
      [{ path: 'src/PricingCard/index.tsx', line: 1, text: 'export default function PricingCard() {}' }],
      [],
    )
    expect(suggestions).toEqual([
      expect.objectContaining({ path: 'src/PricingCard/index.tsx', exportName: 'default', reason: 'export+file' }),
    ])
  })

  it('sinks tests and stories, ignores non-code files and caps the list', () => {
    const entries = [
      { path: 'src/PricingCard.stories.tsx', kind: 'file' as const },
      { path: 'docs/PricingCard.md', kind: 'file' as const },
      ...Array.from({ length: 8 }, (_, i) => ({ path: `pkg${i}/PricingCard.ts`, kind: 'file' as const })),
    ]
    const suggestions = rankCodeSuggestions(candidates, [], entries)
    expect(suggestions).toHaveLength(5)
    expect(suggestions.some((s) => s.path.endsWith('.md'))).toBe(false)
    expect(suggestions.some((s) => s.path.includes('.stories.'))).toBe(false)
  })

  it('answers nothing when nothing matches', () => {
    expect(rankCodeSuggestions(candidates, [{ path: 'a.ts', line: 1, text: 'export const Other = 1' }], [])).toEqual([])
  })
})
