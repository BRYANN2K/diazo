/**
 * A small line diff for confirmations. It trims the common head and tail and
 * shows what is left as one hunk: enough to review a config edit or a frame
 * push before saying yes, and linear in the file size (~/.claude.json can be
 * hundreds of kilobytes), unlike a full LCS.
 */

export interface LineDiff {
  added: number
  removed: number
  /** Unified-style text, empty when nothing changed. */
  text: string
}

const CONTEXT = 3

export function lineDiff(before: string, after: string, labels: [string, string] = ['before', 'after']): LineDiff {
  if (before === after) return { added: 0, removed: 0, text: '' }
  const a = before.split('\n')
  const b = after.split('\n')
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const removed = a.slice(head, a.length - tail)
  const added = b.slice(head, b.length - tail)
  const from = Math.max(0, head - CONTEXT)
  const lines = [
    `--- ${labels[0]}`,
    `+++ ${labels[1]}`,
    `@@ line ${from + 1} @@`,
    ...a.slice(from, head).map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    ...a.slice(a.length - tail, a.length - tail + CONTEXT).map((line) => ` ${line}`),
  ]
  return { added: added.length, removed: removed.length, text: lines.join('\n') }
}
