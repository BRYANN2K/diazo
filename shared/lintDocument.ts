/**
 * Which document a lint verdict scored. The collector measures the frame's
 * HTML at the frame's size (overflow and edge rules read the viewport), so a
 * verdict stands for that HTML at that width and height and no other. The
 * key is short (a hash, the length and the size), so it can ride in the
 * verdict, be compared on every render and be kept per frame for a tab's life.
 */

export interface LintDocument {
  html: string
  width: number
  height: number
}

/* FNV-1a, 32 bits: no crypto, the same in the browser and on the server */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

/** The key of one document at one size, e.g. `1x9k2a.5120@1440x900`. */
export function lintDocKey(doc: LintDocument): string {
  return `${fnv1a(doc.html)}.${doc.html.length}@${Math.round(doc.width)}x${Math.round(doc.height)}`
}
