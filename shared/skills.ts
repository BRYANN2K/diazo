/**
 * Canvas skills (upstream issue #380): named, reusable know-how a canvas
 * carries for its agents — a saved brief, the house style, "how we do a
 * pricing page here". Unlike a guideline, which every agent must follow on
 * every run, a skill is loaded only when the work matches its description:
 * agents see the list (name + when to use it) and fetch the body with
 * get_skill. A person can also name one in an ask as `/name`, and the
 * resident agent then loads it whatever the description says.
 */

export interface CanvasSkill {
  /** slug, unique per canvas (e.g. "pricing-page") */
  name: string
  /** when to use it: the one line an agent reads before deciding to load it */
  description: string
  /** the instructions themselves, markdown */
  markdown: string
  updatedAt: number
  updatedBy: string
}

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
export const MAX_SKILL_DESCRIPTION_CHARS = 280
export const MAX_SKILL_CHARS = 24_000
export const MAX_SKILLS = 30

/** A skill name as typed ("Pricing Page", " pricing-page ") turned into its slug. */
export function skillSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

/** The skills an ask names as `/name`, in the order it names them, each once.
 *  A `/name` inside a word or a path (`a/b`, `https://x/y`) does not count. */
export function invokedSkills(text: string, skills: readonly Pick<CanvasSkill, 'name'>[]): string[] {
  const known = new Set(skills.map((s) => s.name))
  const found: string[] = []
  for (const m of text.matchAll(/(^|[\s(])\/([a-z0-9][a-z0-9-]{0,63})(?=$|[\s.,;:!?)])/gi)) {
    const name = (m[2] ?? '').toLowerCase()
    if (known.has(name) && !found.includes(name)) found.push(name)
  }
  return found
}
