import { useEffect, useState } from 'react'
import type { BuildInfo } from '../../shared/buildInfo'

/** `GET /api/version`, asked once per page load: the build cannot change
 *  under a running page (an update restarts the server, and the page). */
let pending: Promise<BuildInfo> | null = null

export function loadBuildInfo(): Promise<BuildInfo> {
  pending ??= fetch('/api/version').then((r) => {
    if (!r.ok) throw new Error(`version ${r.status}`)
    return r.json() as Promise<BuildInfo>
  })
  pending.catch(() => {
    pending = null
  })
  return pending
}

export function useBuildInfo(): BuildInfo | null {
  const [info, setInfo] = useState<BuildInfo | null>(null)
  useEffect(() => {
    let live = true
    loadBuildInfo()
      .then((next) => live && setInfo(next))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
  return info
}
