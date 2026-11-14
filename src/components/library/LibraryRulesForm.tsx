import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { LibraryPreview } from '../../../shared/library'
import { parseLibraryRules, type LibraryRules } from '../../../shared/libraryRules'
import { api } from '../../lib/api'
import { useT } from '../../lib/i18n'
import { Button } from '../ui/button'
import { CardHeader, CardRow, CardTitle, SettingsCard } from '../ui/card'
import { Input } from '../ui/input'
import { Segmented, SegmentedItem } from '../ui/segmented'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Switch } from '../ui/switch'
import { Textarea } from '../ui/textarea'

/** How long an edit settles before its effect is previewed. */
export const PREVIEW_DEBOUNCE_MS = 400

const list = (text: string) =>
  text
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

function synonymsText(synonyms: Record<string, string[]>): string {
  return Object.entries(synonyms)
    .map(([word, others]) => `${word}: ${others.join(', ')}`)
    .join('\n')
}

function parseSynonyms(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const line of text.split('\n')) {
    const at = line.indexOf(':')
    if (at < 1) continue
    out[line.slice(0, at).trim().toLowerCase()] = list(line.slice(at + 1))
  }
  return out
}

/**
 * A library's rules, one card per group, with their effect previewed (a dry
 * run of the edited rules, 400 ms after the last edit) before saving.
 */
export function LibraryRulesForm({
  libraryId,
  rules: initial,
  onSaved,
}: {
  libraryId: string
  rules: LibraryRules
  onSaved?: (rules: LibraryRules) => void
}) {
  const t = useT()
  const [rules, setRules] = useState<LibraryRules>(initial)
  const [synonyms, setSynonyms] = useState(() => synonymsText(initial.search.synonyms))
  const [baseline, setBaseline] = useState<LibraryPreview | null>(null)
  const [preview, setPreview] = useState<LibraryPreview | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const first = useRef(true)

  const candidate = useMemo(() => ({ ...rules, search: { synonyms: parseSynonyms(synonyms) } }), [rules, synonyms])
  const parsed = parseLibraryRules(candidate)
  const errors = parsed.ok ? new Map<string, string>() : new Map(parsed.errors.map((e) => [e.path, e.message]))

  /* the rules as saved, once: what an edit is compared against */
  useEffect(() => {
    api
      .previewLibrary(libraryId)
      .then((r) => setBaseline(r.preview))
      .catch(() => {})
  }, [libraryId])

  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (!parsed.ok) return
    let stale = false
    const timer = window.setTimeout(() => {
      api
        .previewLibrary(libraryId, { rules: candidate })
        .then((r) => {
          if (!stale) setPreview(r.preview)
        })
        .catch(() => {})
    }, PREVIEW_DEBOUNCE_MS)
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [libraryId, candidate, parsed.ok])

  const set = (patch: (r: LibraryRules) => LibraryRules) => {
    setSaved(false)
    setRules((r) => patch(structuredClone(r)))
  }

  async function save() {
    if (!parsed.ok) return
    setSaving(true)
    try {
      await api.updateLibrary(libraryId, { rules: parsed.rules })
      setSaved(true)
      onSaved?.(parsed.rules)
    } finally {
      setSaving(false)
    }
  }

  const error = (path: string): ReactNode =>
    errors.has(path) ? (
      <span data-error-for={path} role="alert" className="text-caption text-accent-ink">
        {errors.get(path)}
      </span>
    ) : null

  const v = rules.detect.variants
  return (
    <div className="flex gap-6">
      <div className="min-w-0 flex-1">
        <SettingsCard>
          <CardHeader>
            <CardTitle>{t('library.rulesIds')}</CardTitle>
          </CardHeader>
          <CardRow
            label={t('library.rulesPattern')}
            control={
              <Select
                value={rules.ids.pattern}
                onValueChange={(p) =>
                  set((r) => ({ ...r, ids: { ...r.ids, pattern: p as LibraryRules['ids']['pattern'] } }))
                }
              >
                <SelectTrigger className="w-full" aria-label={t('library.rulesPattern')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="kind.source-slug">kind.source-slug</SelectItem>
                  <SelectItem value="kind.slug">kind.slug</SelectItem>
                  <SelectItem value="slug">slug</SelectItem>
                </SelectContent>
              </Select>
            }
          />
          <CardRow
            label={t('library.rulesDefaultKind')}
            control={
              <Input
                variant="well"
                aria-label={t('library.rulesDefaultKind')}
                value={rules.ids.defaultKind}
                onChange={(e) => set((r) => ({ ...r, ids: { ...r.ids, defaultKind: e.target.value } }))}
              />
            }
          >
            {error('ids.defaultKind')}
          </CardRow>
          <CardRow
            label={t('library.rulesNaming')}
            control={
              <Segmented
                value={rules.naming.frameName}
                onValueChange={(n) =>
                  set((r) => ({ ...r, naming: { frameName: n as LibraryRules['naming']['frameName'] } }))
                }
              >
                <SegmentedItem value="{id} — {label}">{'{id} — {label}'}</SegmentedItem>
                <SegmentedItem value="{label}">{'{label}'}</SegmentedItem>
              </Segmented>
            }
          />
        </SettingsCard>

        <SettingsCard>
          <CardHeader>
            <CardTitle>{t('library.rulesDetection')}</CardTitle>
          </CardHeader>
          <CardRow
            label={t('library.rulesIgnore')}
            control={
              <Input
                variant="well"
                aria-label={t('library.rulesIgnore')}
                value={rules.detect.ignore.join(', ')}
                onChange={(e) => set((r) => ({ ...r, detect: { ...r.detect, ignore: list(e.target.value) } }))}
              />
            }
          />
          <CardRow
            label={t('library.rulesSection')}
            control={
              <Input
                variant="well"
                aria-label={t('library.rulesSection')}
                value={rules.detect.section ?? ''}
                onChange={(e) =>
                  set((r) => ({
                    ...r,
                    detect: { ...r.detect, section: e.target.value.trim() ? e.target.value : null },
                  }))
                }
              />
            }
          />
          <CardRow
            label={t('library.rulesVariants')}
            control={
              <Segmented
                aria-label={t('library.rulesVariants')}
                value={v.mode}
                onValueChange={(mode) =>
                  set((r) => ({
                    ...r,
                    detect: {
                      ...r.detect,
                      variants: { ...r.detect.variants, mode: mode as LibraryRules['detect']['variants']['mode'] },
                    },
                  }))
                }
              >
                <SegmentedItem value="auto">{t('library.rulesAuto')}</SegmentedItem>
                <SegmentedItem value="selectors">{t('library.rulesSelectors')}</SegmentedItem>
                <SegmentedItem value="none">{t('library.rulesNone')}</SegmentedItem>
              </Segmented>
            }
          />
          {v.mode === 'selectors' &&
            (['cell', 'id', 'label', 'design'] as const).map((key) => (
              <CardRow
                key={key}
                label={t(`library.rulesSelector_${key}`)}
                control={
                  <Input
                    variant="well"
                    aria-label={t(`library.rulesSelector_${key}`)}
                    value={v[key] ?? ''}
                    onChange={(e) =>
                      set((r) => ({
                        ...r,
                        detect: {
                          ...r.detect,
                          variants: { ...r.detect.variants, [key]: e.target.value || undefined },
                        },
                      }))
                    }
                  />
                }
              >
                {error(`detect.variants.${key}`)}
              </CardRow>
            ))}
        </SettingsCard>

        <SettingsCard>
          <CardHeader>
            <CardTitle>{t('library.rulesCategories')}</CardTitle>
          </CardHeader>
          <CardRow
            label={t('library.rulesCategoriseBy')}
            control={
              <Input
                variant="well"
                aria-label={t('library.rulesCategoriseBy')}
                value={rules.categorise.by.join(', ')}
                onChange={(e) =>
                  set((r) => ({
                    ...r,
                    categorise: { ...r.categorise, by: list(e.target.value) as LibraryRules['categorise']['by'] },
                  }))
                }
              />
            }
          >
            {error('categorise.by.0') ??
              error('categorise.by.1') ??
              error('categorise.by.2') ??
              error('categorise.by.3')}
          </CardRow>
          <CardRow
            label={t('library.rulesFallback')}
            control={
              <Input
                variant="well"
                aria-label={t('library.rulesFallback')}
                value={rules.categorise.fallback}
                onChange={(e) => set((r) => ({ ...r, categorise: { ...r.categorise, fallback: e.target.value } }))}
              />
            }
          >
            {error('categorise.fallback')}
          </CardRow>
        </SettingsCard>

        <SettingsCard>
          <CardHeader>
            <CardTitle>{t('library.rulesCss')}</CardTitle>
          </CardHeader>
          <CardRow label={t('library.rulesInlineSymbols')}>
            <Switch
              aria-label={t('library.rulesInlineSymbols')}
              checked={rules.css.inlineSymbols}
              onCheckedChange={(on) => set((r) => ({ ...r, css: { ...r.css, inlineSymbols: on } }))}
            />
          </CardRow>
          <CardRow
            label={t('library.rulesTokens')}
            control={
              <Segmented
                value={rules.tokens.map}
                onValueChange={(map) => set((r) => ({ ...r, tokens: { map: map as LibraryRules['tokens']['map'] } }))}
              >
                <SegmentedItem value="off">{t('library.rulesOff')}</SegmentedItem>
                <SegmentedItem value="suggest">{t('library.rulesSuggest')}</SegmentedItem>
                <SegmentedItem value="apply">{t('library.rulesApply')}</SegmentedItem>
              </Segmented>
            }
          />
        </SettingsCard>

        <SettingsCard>
          <CardHeader>
            <CardTitle>{t('library.rulesQuality')}</CardTitle>
          </CardHeader>
          <CardRow
            label={t('library.rulesGate')}
            control={
              <Segmented
                value={rules.lint.gate}
                onValueChange={(gate) =>
                  set((r) => ({ ...r, lint: { ...r.lint, gate: gate as LibraryRules['lint']['gate'] } }))
                }
              >
                <SegmentedItem value="off">{t('library.rulesOff')}</SegmentedItem>
                <SegmentedItem value="warn">{t('library.rulesWarn')}</SegmentedItem>
                <SegmentedItem value="draft">{t('library.status_draft')}</SegmentedItem>
              </Segmented>
            }
          />
          <CardRow
            label={t('library.rulesMinScore')}
            control={
              <Input
                variant="well"
                inputMode="numeric"
                aria-label={t('library.rulesMinScore')}
                value={String(rules.lint.minScore)}
                onChange={(e) => set((r) => ({ ...r, lint: { ...r.lint, minScore: Number(e.target.value) } }))}
              />
            }
          >
            {error('lint.minScore')}
          </CardRow>
          <CardRow
            label={t('library.rulesDuplicates')}
            control={
              <Select
                value={rules.dedup.onDuplicate}
                onValueChange={(d) =>
                  set((r) => ({ ...r, dedup: { ...r.dedup, onDuplicate: d as LibraryRules['dedup']['onDuplicate'] } }))
                }
              >
                <SelectTrigger className="w-full" aria-label={t('library.rulesDuplicates')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">{t('library.status_draft')}</SelectItem>
                  <SelectItem value="skip">{t('library.rulesSkip')}</SelectItem>
                  <SelectItem value="replace">{t('library.rulesReplace')}</SelectItem>
                </SelectContent>
              </Select>
            }
          />
        </SettingsCard>

        <SettingsCard>
          <CardHeader>
            <CardTitle>{t('library.rulesSynonyms')}</CardTitle>
          </CardHeader>
          <CardRow
            controlWidth="lg"
            control={
              <Textarea
                variant="well"
                aria-label={t('library.rulesSynonyms')}
                value={synonyms}
                onChange={(e) => setSynonyms(e.target.value)}
              />
            }
          />
        </SettingsCard>

        <div className="mt-4 flex items-center gap-3">
          <Button variant="primary" disabled={!parsed.ok || saving} onClick={() => void save()}>
            {t('library.save')}
          </Button>
          {saved && <span className="text-caption text-ink-faint">{t('library.rulesSaved')}</span>}
        </div>
      </div>
      <aside className="w-60 flex-none pt-4 text-copy text-ink-soft" data-testid="rules-preview" aria-live="polite">
        <p className="font-medium text-ink">{t('library.rulesWhatChanges')}</p>
        {preview && baseline ? (
          <ul className="mt-2 flex flex-col gap-1">
            <li>{t('library.rulesFamiliesDelta', { before: baseline.families, after: preview.families })}</li>
            <li>{t('library.rulesVariantsDelta', { before: baseline.variants, after: preview.variants })}</li>
            <li>
              {t('library.rulesIgnoredDelta', { before: baseline.ignored.length, after: preview.ignored.length })}
            </li>
          </ul>
        ) : (
          <p className="mt-2 text-caption text-ink-faint">{t('library.rulesEditToPreview')}</p>
        )}
      </aside>
    </div>
  )
}
