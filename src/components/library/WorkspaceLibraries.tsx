import { useEffect, useState } from 'react'
import type { LibraryListEntry } from '../../../shared/library'
import { api } from '../../lib/api'
import { navigate } from '../../lib/navigate'
import { useT } from '../../lib/i18n'
import { LibraryTile } from './LibraryTile'

/** A workspace's design libraries, as tiles: every member can use them. */
export function WorkspaceLibraries({ workspaceId }: { workspaceId: string }) {
  const t = useT()
  const [libraries, setLibraries] = useState<LibraryListEntry[]>([])
  useEffect(() => {
    Promise.resolve()
      .then(() => api.listLibraries('workspace'))
      .then((r) => setLibraries(r.libraries.filter((l) => l.workspaceId === workspaceId)))
      .catch(() => {})
  }, [workspaceId])
  if (!libraries.length) return null
  return (
    <section className="mt-5 max-w-[1000px]" data-testid="workspace-libraries">
      <h2 className="mb-2 text-label font-medium text-ink-soft">{t('library.workspaceLibraries')}</h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
        {libraries.map((l) => (
          <LibraryTile key={l.id} library={l} onOpen={() => navigate(`/l/${l.id}`)} />
        ))}
      </div>
    </section>
  )
}
