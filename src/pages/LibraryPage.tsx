import { AppRail, railLayout } from '../components/AppRail'
import { DashContent, DashLayout, DashMain } from '../components/ui/dash'

/** One library's gallery (`/l/<id>`), built in the next step. */
export function LibraryPage({ libraryId }: { libraryId: string; itemId: string | null }) {
  return (
    <DashLayout className={railLayout}>
      <AppRail active="libraries" />
      <DashMain className="[background:var(--paper)]">
        <DashContent data-library-id={libraryId} />
      </DashMain>
    </DashLayout>
  )
}
