import { useEffect, useState, useSyncExternalStore } from 'react'
import type { UpdateStatus } from '../../shared/updateCheck'

/**
 * `GET /api/update-status` (server/updateCheck.ts): whether a newer build of
 * this instance is out. Only admins and a local install's user get an
 * answer; anyone else gets a 404, read here as "nothing to show". The server
 * keeps GitHub's answer an hour, so asking once per page load is cheap.
 */
export async function fetchUpdateStatus(): Promise<UpdateStatus | null> {
  try {
    const res = await fetch('/api/update-status')
    return res.ok ? ((await res.json()) as UpdateStatus) : null
  } catch {
    return null
  }
}

/** The status for a signed-in user (pass their id), null until known or
 *  when they may not see it. */
export function useUpdateStatus(userId: string | undefined): UpdateStatus | null {
  const [status, setStatus] = useState<{ userId: string; status: UpdateStatus | null } | null>(null)
  useEffect(() => {
    if (!userId) return
    let live = true
    void fetchUpdateStatus().then((next) => live && setStatus({ userId, status: next }))
    return () => {
      live = false
    }
  }, [userId])
  return status && status.userId === userId ? status.status : null
}

/* ------------------------------------------------------------ dismissal */

/** The commit whose card was dismissed, per browser: a newer build brings
 *  the card back. */
export const UPDATE_DISMISSED_KEY = 'doop:update-dismissed'

const listeners = new Set<() => void>()

function readDismissed(): string | null {
  try {
    return localStorage.getItem(UPDATE_DISMISSED_KEY)
  } catch {
    return null
  }
}

export function dismissUpdate(latest: string): void {
  try {
    localStorage.setItem(UPDATE_DISMISSED_KEY, latest)
  } catch {
    /* private mode: dismissed for this page only */
  }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === UPDATE_DISMISSED_KEY) listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

export function useDismissedUpdate(): string | null {
  return useSyncExternalStore(subscribe, readDismissed, () => null)
}
