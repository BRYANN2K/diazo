import { useEffect, useState } from 'react'
import type { LibraryListEntry } from '../../../shared/library'
import { api } from '../../lib/api'
import { navigate } from '../../lib/navigate'
import { useT } from '../../lib/i18n'
import { Button } from '../ui/button'
import { LibraryTile } from './LibraryTile'

/** Community's Libraries shelf: the instance's public libraries. "Use" adds
 *  one to the person's libraries, "Copy" makes a canvas of their own. */
export function PublicLibrariesShelf() {
  const t = useT()
  const [libraries, setLibraries] = useState<LibraryListEntry[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => {
    Promise.resolve()
      .then(() => api.publicLibraries())
      .then((r) => setLibraries(r.libraries))
      .catch(() => {})
  }, [])
  if (!libraries.length) return null

  async function use(id: string) {
    const current = await api.getLibrary()
    const ids = [...new Set([...current.canvases.map((c) => c.id), id])]
    await api.setLibrary(ids)
    setNotice(t('library.listed'))
  }

  return (
    <section className="mt-6" data-testid="public-libraries">
      <h2 className="mb-2 text-label font-medium text-ink-soft">{t('library.shelfTitle')}</h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
        {libraries.map((l) => (
          <div key={l.id} className="flex flex-col gap-2">
            <LibraryTile library={l} onOpen={() => navigate(`/l/${l.id}`)} />
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void use(l.id).catch(() => {})}>
                {t('library.use')}
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  void api
                    .copyLibrary(l.id)
                    .then((r) => navigate(`/c/${r.id}`))
                    .catch(() => {})
                }
              >
                {t('library.copy')}
              </Button>
            </div>
          </div>
        ))}
      </div>
      {notice && <p className="mt-2 text-caption text-ink-faint">{notice}</p>}
    </section>
  )
}
