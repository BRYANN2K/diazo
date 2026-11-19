/**
 * The server's "is there a newer build?" answer (server/updateCheck.ts),
 * shown to instance admins and to the person running a local install.
 */

/** How this instance was installed, which decides how it updates. */
export type InstallType = 'local' | 'docker' | 'kubernetes' | 'source' | 'desktop'

export const INSTALL_TYPES: readonly InstallType[] = ['local', 'docker', 'kubernetes', 'source', 'desktop']

export type UpdateState =
  /** the check is switched off (DOOP_UPDATE_CHECK=false) */
  | 'disabled'
  /** running the newest published build */
  | 'current'
  /** the published build has commits this one lacks */
  | 'behind'
  /** this build is newer than the published one (a dev checkout, a build ahead of its image) */
  | 'ahead'
  /** both sides have commits the other lacks (a local branch) */
  | 'diverged'
  /** no answer: see `reason` */
  | 'unknown'

export type UnknownReason =
  /** the build does not know its own commit (built without DOOP_BUILD_SHA) */
  | 'no-build-sha'
  /** GitHub does not know the repository, the branch or the running commit */
  | 'not-found'
  /** GitHub's unauthenticated rate limit is spent; asked again after its reset */
  | 'rate-limited'
  /** offline, a timeout, or an answer that did not parse */
  | 'unreachable'

export interface UpdateCommit {
  sha: string
  /** the first line of the commit message */
  title: string
  url: string
}

export interface UpdateStatus {
  state: UpdateState
  reason?: UnknownReason
  install: InstallType
  /** `owner/name` on GitHub */
  repo: string
  branch: string
  /** the running commit, null when unknown */
  running: string | null
  /** the commit the newest published build was made from */
  latest: string | null
  /** what `latest` is: the newest commit whose image build succeeded, or
   *  the branch head when the repository has no such workflow */
  source: 'image' | 'branch'
  /** commits `latest` has that the running build lacks */
  behindBy: number
  /** commits the running build has that `latest` lacks */
  aheadBy: number
  /** the new commits, newest first, at most MAX_LISTED_COMMITS */
  commits: UpdateCommit[]
  /** GitHub's page comparing the running build with the latest */
  compareUrl: string | null
  /** when GitHub was last asked (ISO 8601), null when it never was */
  checkedAt: string | null
}

export const MAX_LISTED_COMMITS = 20

/** The command that updates an install of this type. */
export function updateCommand(install: InstallType): string {
  switch (install) {
    case 'local':
      return 'diazo-local update'
    case 'docker':
      return 'docker compose pull && docker compose up -d'
    case 'kubernetes':
      return 'kubectl -n doop rollout restart deploy/doop'
    case 'source':
      return 'git pull && bun install && bun run build'
    case 'desktop':
      return ''
  }
}

/** What the card offers as dismissed: the newest commit on offer, so a
 *  newer build brings it back. */
export function updateKey(status: UpdateStatus): string | null {
  return status.state === 'behind' || status.state === 'diverged' ? status.latest : null
}
