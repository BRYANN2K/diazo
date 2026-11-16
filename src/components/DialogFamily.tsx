import { createContext, useContext, type ReactNode } from 'react'
import { useT } from '@/lib/i18n'
import { Segmented, SegmentedItem } from './ui/segmented'

export type DialogFamilyMember = 'share' | 'export' | 'import'

interface DialogFamilyValue {
  /** the members this person may open (no Import for a reader) */
  available: readonly DialogFamilyMember[]
  switchTo: (next: DialogFamilyMember) => void
}

const DialogFamilyContext = createContext<DialogFamilyValue | null>(null)

/** The canvas page lends its Share, Export and Import dialogs one switch. */
export function DialogFamilyProvider({ value, children }: { value: DialogFamilyValue; children: ReactNode }) {
  return <DialogFamilyContext.Provider value={value}>{children}</DialogFamilyContext.Provider>
}

/**
 * "Share · Export · Import — one dialog family": the strip at the top of each
 * of the three dialogs that turns one into another without going back to the
 * bar. Outside the canvas page (no provider) it draws nothing.
 */
export function DialogFamilyTabs({ active }: { active: DialogFamilyMember }) {
  const t = useT()
  const family = useContext(DialogFamilyContext)
  if (!family || family.available.length < 2) return null
  const labels: Record<DialogFamilyMember, string> = {
    share: t('canvas.share'),
    export: t('canvas.export'),
    import: t('canvas.import'),
  }
  return (
    <Segmented
      aria-label={t('canvas.dialogFamilyAria')}
      value={active}
      onValueChange={(next) => next !== active && family.switchTo(next as DialogFamilyMember)}
      className="mt-4 mb-1 w-full"
    >
      {family.available.map((member) => (
        <SegmentedItem key={member} value={member} className="flex-1 sm:flex-1">
          {labels[member]}
        </SegmentedItem>
      ))}
    </Segmented>
  )
}
