import type { LibraryFacet } from '../../../shared/library'
import { useT } from '../../lib/i18n'
import { DashNavItem, DashSectionLabel } from '../ui/dash'
import { ToggleChipGroup, ToggleChipItem } from '../ui/toggle-chip'

/** The gallery's left column: kinds as chips, then the categories with their
 *  family counts. The empty value is "all". */
export function LibraryFacets({
  kinds,
  categories,
  kind,
  category,
  onKind,
  onCategory,
}: {
  kinds: LibraryFacet[]
  categories: LibraryFacet[]
  kind: string
  category: string
  onKind: (kind: string) => void
  onCategory: (category: string) => void
}) {
  const t = useT()
  return (
    <aside className="flex w-56 flex-none flex-col gap-3" aria-label={t('library.facets')}>
      {kinds.length > 0 && (
        <ToggleChipGroup
          className="gap-1"
          aria-label={t('library.kinds')}
          value={kind || 'all'}
          onValueChange={(next) => onKind(next === 'all' ? '' : next)}
        >
          <ToggleChipItem size="sm" value="all">
            {t('library.allKinds')}
          </ToggleChipItem>
          {kinds.map((k) => (
            <ToggleChipItem key={k.value} size="sm" value={k.value}>
              {k.label}
            </ToggleChipItem>
          ))}
        </ToggleChipGroup>
      )}
      <div>
        <DashSectionLabel density="rail">{t('library.categories')}</DashSectionLabel>
        <nav className="flex flex-col gap-0.5" data-testid="library-categories-nav">
          <DashNavItem density="rail" active={!category} onClick={() => onCategory('')}>
            {t('library.allCategories')}
          </DashNavItem>
          {categories.map((c) => (
            <DashNavItem
              key={c.value}
              density="rail"
              active={category === c.value}
              count={c.count}
              onClick={() => onCategory(c.value)}
            >
              {c.label}
            </DashNavItem>
          ))}
        </nav>
      </div>
    </aside>
  )
}
