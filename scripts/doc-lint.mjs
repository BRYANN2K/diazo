#!/usr/bin/env node
// scripts/doc-lint.mjs
//
// Keeps the repository's documentation layout honest in CI. Zero dependencies;
// Node 18+.
//
// Layout it enforces: the root files (AGENTS.md, CLAUDE.md, README.md, …), the
// standing docs in docs/, the ADR index in docs/adr/README.md, the Stip changes
// in .workflow/changes/, and every relative markdown link in those files.
//
// Errors fail the build (exit 1). Warnings are printed and pass.
//   DOCLINT_SKIP=1                     exit 0 immediately, check nothing
//   --warn-only | DOCLINT_WARN_ONLY=1  run every rule, print errors, still exit 0

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

if (process.env.DOCLINT_SKIP) {
  console.log('doc-lint skipped (DOCLINT_SKIP is set)')
  process.exit(0)
}
const WARN_ONLY = process.argv.includes('--warn-only') || !!process.env.DOCLINT_WARN_ONLY

// ================================ CONFIG ================================

const REQUIRED_ROOT_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'LICENSE',
  'NOTICE',
  'THIRD-PARTY-LICENSES',
]

const REQUIRED_DOCS = [
  'docs/PRD.md',
  'docs/TRD.md',
  'docs/ROADMAP.md',
  'docs/RELEASE.md',
  'docs/GLOSSARY.md',
  'docs/adr/README.md',
  'docs/adr/TEMPLATE.md',
]

// Markdown whose relative links must resolve. Directories are walked.
const LINKED_DOCS = ['.', 'docs', '.workflow/project.md', '.workflow/specs', '.workflow/changes', '.workflow/archive']

// Never walked: vendored, generated or inherited trees.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'target', 'extensions', '.claude', 'storybook-static'])

// Source trees checked for comments that still cite the retired .context/ folder.
const SOURCE_DIRS = ['src', 'server', 'shared', 'tests', 'cli', 'desktop/src-tauri/src']
const SOURCE_EXT_RE = /\.(ts|tsx|js|mjs|rs)$/

const AGENTS_MD_MAX_LINES = 150
const PLACEHOLDER_RE = /<Product>|<Project>|\bYYYY-MM-DD\b/

// ============================== END CONFIG ==============================

const errors = []
const warnings = []
const rel = (p) => relative(ROOT, p).split('\\').join('/')
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null)

function walk(dir, keep, top = true) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) || (top && dir === ROOT) ? [] : walk(p, keep, false)
    return keep(p) ? [p] : []
  })
}

const isMarkdown = (p) => extname(p) === '.md'

// Markdown link targets outside code spans and fences, fragments stripped,
// external URLs and in-page anchors dropped.
function linkTargets(src) {
  const prose = src.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
  const targets = []
  for (const match of prose.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1].split('#')[0]
    if (target && !/^[a-z][a-z0-9+.-]*:/i.test(target)) targets.push(decodeURIComponent(target))
  }
  return targets
}

// ------------------------- Rule 1: root files -------------------------

for (const f of [...REQUIRED_ROOT_FILES, ...REQUIRED_DOCS]) {
  if (!existsSync(join(ROOT, f))) errors.push(`Missing required file: ${f}`)
}

// --------------------- Rule 2: AGENTS.md and CLAUDE.md ---------------------

const claudeMd = read(join(ROOT, 'CLAUDE.md'))
if (claudeMd !== null && !/^@AGENTS\.md\s*$/m.test(claudeMd)) {
  errors.push('CLAUDE.md must import AGENTS.md ("@AGENTS.md" on its own line)')
}
const agentsMd = read(join(ROOT, 'AGENTS.md'))
// Lines outside Stip's managed block (<!-- spec-workflow:start --> … end), which the tool owns.
const agentsOwn = agentsMd?.replace(/<!-- spec-workflow:start -->[\s\S]*?<!-- spec-workflow:end -->/, '') ?? null
if (agentsOwn !== null && agentsOwn.split('\n').length > AGENTS_MD_MAX_LINES) {
  warnings.push(`AGENTS.md is over ${AGENTS_MD_MAX_LINES} lines; move facts into docs/ and link them`)
}

// ------------------------- Rule 3: relative links -------------------------

const markdownFiles = LINKED_DOCS.flatMap((entry) => {
  const p = join(ROOT, entry)
  if (entry === '.')
    return readdirSync(ROOT)
      .filter((name) => isMarkdown(name))
      .map((name) => join(ROOT, name))
  return isMarkdown(p) ? [p] : walk(p, isMarkdown)
})

for (const file of markdownFiles) {
  for (const target of linkTargets(readFileSync(file, 'utf8'))) {
    if (!existsSync(resolve(dirname(file), target)))
      errors.push(`${rel(file)} links to "${target}", which does not exist`)
  }
}

// ------------------------- Rule 4: the ADR index -------------------------

const adrDir = join(ROOT, 'docs/adr')
const adrIndex = read(join(adrDir, 'README.md'))
if (adrIndex !== null) {
  const listed = new Set(linkTargets(adrIndex).map((t) => t.replace(/^\.\//, '')))
  const adrs = readdirSync(adrDir)
    .filter((name) => /^\d{4}-.+\.md$/.test(name))
    .sort()
  adrs.forEach((name, i) => {
    const expected = String(i + 1).padStart(4, '0')
    if (!name.startsWith(`${expected}-`))
      errors.push(`docs/adr/${name}: expected number ${expected} (no gaps, no reuse)`)
    if (!listed.has(name)) errors.push(`docs/adr/${name} is not listed in docs/adr/README.md`)
  })
}

// ------------------------- Rule 5: Stip changes -------------------------

const changesDir = join(ROOT, '.workflow/changes')
if (existsSync(changesDir)) {
  for (const entry of readdirSync(changesDir, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const dir = join(changesDir, entry.name)
    for (const f of ['proposal.md', 'spec.md', 'state.json']) {
      if (!existsSync(join(dir, f))) errors.push(`.workflow/changes/${entry.name} has no ${f}`)
    }
    const spec = read(join(dir, 'spec.md'))
    if (spec !== null && !/^- AC-\d+:/m.test(spec)) {
      warnings.push(`.workflow/changes/${entry.name}/spec.md has no "- AC-n:" criteria yet`)
    }
  }
}

// ------------------------- Rule 6: placeholders -------------------------

for (const f of REQUIRED_DOCS.filter((d) => !d.endsWith('TEMPLATE.md'))) {
  const src = read(join(ROOT, f))
  if (src !== null && PLACEHOLDER_RE.test(src)) warnings.push(`${f} still contains a template placeholder`)
}

// -------------- Rule 7: source comments citing retired paths --------------

const stale = SOURCE_DIRS.flatMap((d) => walk(join(ROOT, d), (p) => SOURCE_EXT_RE.test(p))).filter((p) =>
  /\.context\/|FORK\.md/.test(readFileSync(p, 'utf8')),
)
for (const p of stale) warnings.push(`${rel(p)} cites .context/ or FORK.md; point it at docs/ or .workflow/`)

// ------------------------------- Report -------------------------------

if (warnings.length > 0) {
  console.log('doc-lint warnings:')
  for (const w of warnings) console.log(`  ! ${w}`)
  console.log('')
}
if (errors.length > 0) {
  console.log('doc-lint errors:')
  for (const e of errors) console.log(`  x ${e}`)
  console.log(
    `\ndoc-lint ${WARN_ONLY ? 'found' : 'failed:'} ${errors.length} error(s)${WARN_ONLY ? ', not failing (--warn-only)' : ''}`,
  )
  process.exit(WARN_ONLY ? 0 : 1)
}
console.log(`doc-lint passed (${warnings.length} warning(s))`)
