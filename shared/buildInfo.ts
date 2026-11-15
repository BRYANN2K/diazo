/** What `GET /api/version` answers: the build that is running. Public, so
 *  nothing here may be a secret. */
export interface BuildInfo {
  /** package.json's version */
  version: string
  /** the full commit SHA the build was made from; null when unknown */
  sha: string | null
  /** ISO 8601 build time; null for a dev checkout */
  date: string | null
}

const SHA = /^[0-9a-f]{40}$/

/** A full lowercase commit SHA, or null for anything else ("dev", a short
 *  SHA, a typo), so a compare is only ever asked about a real commit. */
export function normalizeSha(value: string | null | undefined): string | null {
  const sha = value?.trim().toLowerCase() ?? ''
  return SHA.test(sha) ? sha : null
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}
