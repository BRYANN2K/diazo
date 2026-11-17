/**
 * bench/rubric.ts — the quality-gate scaffold (agent-cost, AC-22..AC-30).
 *
 * Script mode becomes the default for a brief kind only when it proves equal
 * or better on three fronts, measured over the 12 briefs in briefs.json run
 * in both modes:
 *
 *   measures  — per frame, the medians of every named check are equal or
 *               better than tool mode, and no new error-level finding appears
 *   pairs     — blind visual judging wins or ties at least half the pairs;
 *               each pair is judged in BOTH orders under a fixed rubric by a
 *               vision model, plus a blind human sample of at least 24 pairs
 *   gate      — this module computes the verdict from collected results
 *
 * The measures reuse the server's own checks so the benchmark judges what
 * shipped work is judged by: the anti-slop lint (server/lint.ts), the
 * responsive/accessibility pass (server/frameChecks.ts), and the MO-* motion
 * rules (shared/motionLint.ts).
 */

/** Every measure a frame is scored on; names match the finding rule ids. */
export const MEASURES = [
  'lint_score',
  'check_score',
  'overflow_px',
  'clipped_text',
  'component_reuse',
  'lint_errors', // anti-slop lint findings at error level
  'lint_warnings',
  'responsive_errors', // overflow / clipped text at the checked breakpoints
  'contrast_errors', // text contrast below threshold
  'image_failures', // broken or unreachable <img>/background URLs
  'font_fallbacks', // text that fell back off the intended family
  'token_coverage', // % of color/type declarations on tokens (higher is better)
  'motion_errors', // MO-* findings at error level (storyboards)
] as const

export type Measure = (typeof MEASURES)[number]

/** Higher-is-better measures; everything else counts down to zero. */
export const HIGHER_BETTER: ReadonlySet<Measure> = new Set([
  'token_coverage',
  'lint_score',
  'check_score',
  'component_reuse',
])

export interface FrameScore {
  frameId: string
  measures: Partial<Record<Measure, number>>
  /** error-level findings verbatim, for the "no new errors" clause */
  errors: string[]
}

export interface BriefResult {
  briefId: string
  kind: string
  mode: 'tools' | 'script'
  tier?: string
  repetition?: number
  frames: FrameScore[]
}

export interface PairVerdict {
  pairId?: string
  briefId: string
  /** the brief's kind — the runner and the blind key carry it so the gate
   *  can stratify the human sample across kinds */
  kind?: string
  /** which mode was shown first in this judging pass */
  first: 'tools' | 'script'
  /** 'a' | 'b' | 'tie' — resolved to a mode by the caller that knows the order */
  winner: 'first' | 'second' | 'tie'
  judge: 'vision' | 'human'
}

/** The blind-judge rubric — kept short so both orders score consistently. */
export const PAIR_RUBRIC = `Judge which frame is the better design, strictly on what the screenshots show:
hierarchy and typography, spacing and rhythm, alignment, contrast and
readability, realism of content, and whether anything looks broken, clipped
or generic. Ignore which tool produced it. Answer "first", "second" or "tie".`

/** Median of a measure across a run's frames; missing values skip the frame. */
export function median(scores: FrameScore[], measure: Measure): number | undefined {
  const values = scores
    .map((s) => s.measures[measure])
    .filter((v): v is number => typeof v === 'number')
    .sort((a, b) => a - b)
  if (values.length === 0) return undefined
  const mid = Math.floor(values.length / 2)
  return values.length % 2 ? values[mid] : (values[mid - 1]! + values[mid]!) / 2
}

/** AC-24's quality verdict for one brief kind, from both modes' results.
 *  `pairs` is the FULL pair set across every kind: AC-25's human sample is
 *  24 pairs in total, stratified so no kind goes unsampled — while the
 *  wins-or-ties decision still uses only this kind's pairs. */
export function gateVerdict(
  tools: BriefResult[],
  script: BriefResult[],
  pairs: PairVerdict[],
): { pass: boolean; reasons: string[] } {
  const reasons: string[] = []
  const toolsFrames = tools.flatMap((r) => r.frames)
  const scriptFrames = script.flatMap((r) => r.frames)
  for (const measure of MEASURES) {
    const t = median(toolsFrames, measure)
    const s = median(scriptFrames, measure)
    if (t === undefined || s === undefined) {
      reasons.push(`${measure}: missing measurements`)
      continue
    }
    const better = HIGHER_BETTER.has(measure) ? s < t : s > t
    if (better) reasons.push(`${measure}: script median ${s} vs tools ${t}`)
  }
  if (!tools.length || !script.length) reasons.push('missing benchmark runs')
  for (const candidate of script) {
    const baseline = tools.filter((r) => r.briefId === candidate.briefId)
    if (!baseline.length) reasons.push(`${candidate.briefId}: missing tool baseline`)
    if (candidate.frames.some((f) => f.errors.length) && baseline.every((r) => r.frames.every((f) => !f.errors.length)))
      reasons.push(`${candidate.briefId}: new error-level findings`)
  }
  const briefIds = new Set([...tools, ...script].map((r) => r.briefId))
  const briefKind = new Map([...tools, ...script].map((r) => [r.briefId, r.kind]))
  const kindOf = (p: PairVerdict) => p.kind ?? briefKind.get(p.briefId)
  /* AC-25: the human sample is at least 24 pairs in total — not per kind. */
  const humansAll = pairs.filter((p) => p.judge === 'human')
  if (humansAll.length < 24) reasons.push('blind human sample needs at least 24 pairs in total')
  const sampled = new Set(humansAll.map(kindOf).filter((k): k is string => !!k))
  /* a kind the ballot never drew stays unsampled — this verdict fails it */
  for (const kind of new Set([...tools, ...script].map((r) => r.kind)))
    if (!sampled.has(kind)) reasons.push(`blind human sample does not cover kind "${kind}"`)
  /* the decisions below only see this kind's own pairs */
  const own = pairs.filter((p) => briefIds.has(p.briefId))
  const humans = own.filter((p) => p.judge === 'human')
  const resolved = (p: PairVerdict) =>
    p.winner === 'tie' ? 'tie' : p.winner === 'first' ? p.first : p.first === 'script' ? 'tools' : 'script'
  // Match the human vote to the SAME render pair shown in the same order —
  // keying on briefId alone compares against whichever repetition ran first.
  const disagreement = humansAll.filter((h) => {
    const vision = pairs.find((v) => v.judge === 'vision' && v.pairId === h.pairId && v.first === h.first)
    return !vision || resolved(vision) !== resolved(h)
  }).length
  /* >30% model–human disagreement on the whole sample → Bryan's picks on
     this kind's briefs decide; otherwise the vision model's pairs do */
  const decided =
    humansAll.length && disagreement / humansAll.length > 0.3 ? humans : own.filter((p) => p.judge === 'vision')
  for (const brief of tools) {
    if (
      !['tools', 'script'].every((first) =>
        own.some((p) => p.briefId === brief.briefId && p.judge === 'vision' && p.first === first),
      )
    )
      reasons.push(`${brief.briefId}: judge both presentation orders`)
  }
  const visionPairs = own.filter((p) => p.judge === 'vision')
  if (visionPairs.length >= 8 && new Set(visionPairs.map((p) => p.winner)).size === 1)
    reasons.push(`judge returned "${visionPairs[0]!.winner}" for all ${visionPairs.length} pairs — degenerate judging`)
  /* order consistency: judged in both orders, a pair should name the same
     mode. A judge that answers by position never agrees with itself. */
  const byPair = new Map<string, PairVerdict[]>()
  for (const p of visionPairs)
    if (p.pairId) {
      const list = byPair.get(p.pairId) ?? []
      list.push(p)
      byPair.set(p.pairId, list)
    }
  const consistent = [...byPair.values()].filter(
    (pair) => pair.length >= 2 && pair.every((p) => resolved(p) === resolved(pair[0]!)),
  ).length
  if (byPair.size >= 4 && consistent / byPair.size < 0.5)
    reasons.push(`judge stayed consistent across orders on ${consistent}/${byPair.size} pairs — below the 50% floor`)
  const winsOrTies = decided.filter(
    (p) => p.winner === 'tie' || (p.winner === 'first') === (p.first === 'script'),
  ).length
  if (decided.length === 0 || winsOrTies < decided.length / 2) {
    reasons.push(`blind pairs: ${winsOrTies}/${decided.length} wins-or-ties, needs at least half`)
  }
  return { pass: reasons.length === 0, reasons }
}

/** One row of `blind-key.json` — the private mapping kept out of the ballot. */
export interface BlindKey {
  pairId: string
  briefId: string
  kind?: string
  first: string
  second: string
  /** [mode of file `first`, mode of file `second`] */
  modes: string[]
}

/** One row of a filled-in `human-ballot.json` — `winner` is 'a', 'b' or 'tie'. */
export interface HumanBallotVote {
  pairId: string
  winner: string | null
}

/** Resolve Bryan's ballot into PairVerdicts through the blind key: 'a' picks
 *  the mode behind file `first`, 'b' the mode behind `second`. Ballot rows
 *  left blank or naming no key entry are skipped. */
export function ingestHumanBallot(blindKey: readonly BlindKey[], ballot: readonly HumanBallotVote[]): PairVerdict[] {
  const byId = new Map(blindKey.map((entry) => [entry.pairId, entry]))
  const out: PairVerdict[] = []
  for (const vote of ballot) {
    const entry = byId.get(vote.pairId)
    const pick = vote.winner === 'a' ? 0 : vote.winner === 'b' ? 1 : vote.winner === 'tie' ? -1 : undefined
    if (!entry || pick === undefined) continue
    const first = entry.modes[0]
    if (first !== 'tools' && first !== 'script') continue
    out.push({
      pairId: entry.pairId,
      briefId: entry.briefId,
      ...(entry.kind ? { kind: entry.kind } : {}),
      first,
      winner: pick < 0 ? 'tie' : pick === 0 ? 'first' : 'second',
      judge: 'human',
    })
  }
  return out
}
