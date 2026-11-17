/**
 * Deterministic JSON for conflict checks: object keys serialize in sorted
 * order at every depth, array order is kept. Postgres JSONB reorders keys on
 * the way back out, so a plain JSON.stringify comparison would call a
 * byte-identical row "changed" — canonicalJson makes the comparison about
 * the data, not the column's key order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v !== undefined) out[key] = sortKeys(v)
    }
    return out
  }
  return value
}
