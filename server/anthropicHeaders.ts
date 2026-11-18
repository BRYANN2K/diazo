import { env } from './env.ts'

/**
 * The header names ANTHROPIC_CUSTOM_HEADERS parses to, under their own
 * spellings — the same parse the SDK applies before folding the variable
 * into a client's defaultHeaders ahead of ours.
 */
export function envHeaderNames(): string[] {
  const names: string[] = []
  for (const line of (env.ANTHROPIC_CUSTOM_HEADERS ?? '').split('\n')) {
    const colon = line.indexOf(':')
    const name = colon >= 0 ? line.slice(0, colon).trim() : ''
    if (name) names.push(name)
  }
  return names
}

/**
 * One HTTP header can enter the merge under several spellings — the env's,
 * ours, a person's — and the SDK folds the sources case-insensitively in
 * insertion order, the last spelling of a name winning. Object spread
 * cannot control that order: re-spelling an existing key replaces its
 * value without moving its position, so a value under one spelling still
 * loses to one the same name carries under another.
 *
 * resolvedHeaders settles each name case-insensitively — sources apply
 * lowest precedence first, a later entry in a source wins — then restates
 * the resolved value under EVERY spelling the name appeared in, so every
 * read of it in the merge agrees.
 */
export function resolvedHeaders(...sources: (readonly [string, string | null])[][]): Record<string, string | null> {
  const resolved = new Map<string, { spellings: string[]; value: string | null }>()
  for (const source of sources) {
    for (const [name, value] of source) {
      const folded = name.toLowerCase()
      const entry = resolved.get(folded)
      if (!entry) {
        resolved.set(folded, { spellings: [name], value })
        continue
      }
      if (!entry.spellings.includes(name)) entry.spellings.push(name)
      entry.value = value
    }
  }
  const headers: Record<string, string | null> = {}
  for (const { spellings, value } of resolved.values()) {
    for (const spelling of spellings) headers[spelling] = value
  }
  return headers
}
