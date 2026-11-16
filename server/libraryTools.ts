/**
 * The design-library tools every agent gets, over MCP (server/mcp.ts) and in
 * the resident agent (server/resident.ts): one schema and one handler each,
 * under the same names, so the two cannot drift. A library the account
 * cannot read answers exactly like one that does not exist.
 * Spec: .workflow/specs/design-libraries.md, "Agent tools".
 */
import { z } from 'zod'
import type { Actor, Canvas } from '../shared/types.ts'
import type { LibraryItemSummary } from '../shared/library.ts'
import { describeRules, NON_INSERTABLE_KINDS } from '../shared/libraryRules.ts'
import { store } from './store.ts'
import { getLibrary, libraryAllows, libraryRole } from './libraries.ts'
import { env } from './env.ts'
import { ImportRefusal, runImport } from './libraryImport.ts'
import { describeMatches, findDuplicates, type DuplicateCandidate } from './libraryDuplicates.ts'
import type { DuplicateMatch } from '../shared/libraryProvenance.ts'
import { cleanItemPatch, patchItem } from './libraryRoutes.ts'
import { libraryItems } from './libraryIndex.ts'
import { itemDetail, itemUrl, readableLibraries, searchLibraries } from './libraryQueries.ts'
import { insertItem, InsertError, snapshotItem } from './librarySnapshot.ts'
import { libraryBlock, refId } from '../shared/libraryBlock.ts'
import { jobView, planView, type CurationCategoryView, type CurationJob } from '../shared/libraryCuration.ts'
import { CurationError, curationsOf, getCuration, startCuration } from './libraryCuration.ts'

export interface LibraryToolContext {
  /** whose libraries these are: the account over MCP, the asker in a run */
  userId: string | undefined
  actor: Actor
  /** the libraries this caller may use */
  libraries(): Promise<Canvas[]>
  /** the canvas a resident run works on */
  canvas?: Canvas
  /** may this caller write that canvas? (an insert's target) */
  canEdit(canvasId: string): boolean
  /** may this caller read that canvas? (an import's source) */
  canRead?(canvasId: string): boolean
}

export type LibraryToolResult =
  | { ok: true; data: unknown; note?: string; /** frames the tool wrote */ frames?: string[] }
  | { ok: false; error: string }

interface LibraryTool {
  name: string
  title: string
  description: string
  readOnly: boolean
  shape: z.ZodRawShape
  run(input: Record<string, unknown>, context: LibraryToolContext): Promise<LibraryToolResult>
}

const FAMILY = 'A family is one reusable design; its variants are alternative versions of it, each with its own id.'

const LIBRARY_ID = z.string().describe('Library id from list_libraries (it is the library canvas id)')

/** An item in a tool answer: short, with where to see it and open it. */
function brief(libraryId: string, item: LibraryItemSummary) {
  return {
    id: item.id,
    label: item.label,
    kind: item.kind || undefined,
    source: item.source || undefined,
    category: item.category,
    tags: item.tags.length ? item.tags : undefined,
    status: item.status === 'active' ? undefined : item.status,
    insertable: !NON_INSERTABLE_KINDS.has(item.kind),
    scripted: item.scripted || undefined,
    mode: item.mode === 'component' ? 'component' : undefined,
    thumbnail: item.thumb,
    url: itemUrl(libraryId, item.id),
  }
}

async function readable(context: LibraryToolContext, libraryId: string): Promise<Canvas | null> {
  const list = await context.libraries()
  const canvas = list.find((c) => c.id === libraryId) ?? store.getCanvas(libraryId)
  if (!canvas || !getLibrary(canvas.id) || !libraryRole(context.userId, canvas)) {
    /* a run reads its own library canvas whoever asked */
    if (canvas && context.canvas?.id === canvas.id && getLibrary(canvas.id)) return canvas
    return null
  }
  return canvas
}

const missing = (libraryId: string): LibraryToolResult => ({
  ok: false,
  error: `no library "${libraryId}" — call list_libraries for the ones you can use`,
})

/** The categories of a library with their family counts, as one sorted list. */
async function categoryTree(canvasId: string): Promise<{ path: string; families: number }[]> {
  const counts = new Map<string, number>()
  for (const item of await libraryItems(canvasId)) {
    if (item.parentId || item.status === 'hidden' || item.status === 'draft') continue
    counts.set(item.category, (counts.get(item.category) ?? 0) + 1)
  }
  return [...counts].map(([path, families]) => ({ path, families })).sort((a, b) => a.path.localeCompare(b.path))
}

export const DESIGN_LIBRARY_TOOLS: LibraryTool[] = [
  {
    name: 'list_libraries',
    title: 'List design libraries',
    description:
      'The design libraries you can use: reusable, already-designed components and blocks to start from instead of drawing common patterns. Each has an id, a name, its family and variant counts, its kinds and top categories. ' +
      FAMILY,
    readOnly: true,
    shape: {},
    async run(_input, context) {
      const out = []
      for (const canvas of await context.libraries()) {
        const record = getLibrary(canvas.id)
        if (!record) continue
        const browse = await searchLibraries([canvas], { query: '', limit: 1 })
        out.push({
          id: canvas.id,
          name: canvas.name,
          description: record.description || undefined,
          families: record.counts.items,
          variants: record.counts.variants,
          kinds: browse.facets.kind.map((k) => ({ kind: k.value, label: k.label, families: k.count })),
          top_categories: browse.facets.category.slice(0, 10).map((c) => ({ category: c.value, families: c.count })),
        })
      }
      return {
        ok: true,
        data: { libraries: out },
        ...(out.length ? {} : { note: 'No library is available to this account yet.' }),
      }
    },
  },
  {
    name: 'get_library',
    title: 'Read a design library',
    description:
      'One design library: its description, kinds, sources, every category with its family count, its rules in plain words and how far its indexing got. Use it to learn how a library is organised before searching it.',
    readOnly: true,
    shape: { library_id: LIBRARY_ID },
    async run(input, context) {
      const libraryId = String(input.library_id ?? '')
      const canvas = await readable(context, libraryId)
      const record = canvas && getLibrary(canvas.id)
      if (!canvas || !record) return missing(libraryId)
      const browse = await searchLibraries([canvas], { query: '', limit: 1 })
      return {
        ok: true,
        data: {
          id: canvas.id,
          name: canvas.name,
          description: record.description || undefined,
          families: record.counts.items,
          variants: record.counts.variants,
          kinds: browse.facets.kind.map((k) => ({
            kind: k.value,
            label: k.label,
            families: k.count,
            insertable: !NON_INSERTABLE_KINDS.has(k.value),
          })),
          sources: browse.facets.source.map((s) => {
            const known = record.taxonomy.sources.find((x) => x.id === s.value)
            return { source: s.value, label: s.label, families: s.count, url: known?.url, license: known?.license }
          }),
          categories: await categoryTree(canvas.id),
          rules: describeRules(record.rules),
          index: record.indexState ?? { status: 'idle' },
        },
      }
    },
  },
  {
    name: 'search_library',
    title: 'Search design libraries',
    description:
      'Search the design libraries for a component or block before designing a common pattern (login, pricing, OTP input, chart card…). Answers families with the variants that matched, a thumbnail and a url each. ' +
      FAMILY +
      ' Filters work as arguments or in the query: kind:cp in:"Inputs & forms" tag:dark source:scb.',
    readOnly: true,
    shape: {
      query: z.string().describe('Words, an id or a part of one: "otp", "login button", "cp.scb-otp-input"'),
      library_id: LIBRARY_ID.optional().describe('Search one library; every library you can use when left out'),
      kind: z.string().optional().describe('Only this kind (the id prefix: cp, bk, mo…)'),
      category: z.string().optional().describe('Only this category or its subcategories'),
      tag: z.string().optional(),
      source: z.string().optional(),
      include_drafts: z.boolean().optional().describe('Also items waiting for review'),
      limit: z.number().int().min(1).max(50).optional().describe('Families to return, 20 by default'),
      cursor: z.string().optional().describe('The cursor of a previous answer, for the next page'),
    },
    async run(input, context) {
      const libraryId = typeof input.library_id === 'string' ? input.library_id : ''
      let canvases: Canvas[]
      if (libraryId) {
        const canvas = await readable(context, libraryId)
        if (!canvas) return missing(libraryId)
        canvases = [canvas]
      } else canvases = await context.libraries()
      if (!canvases.length) return { ok: false, error: 'no design library is available to this account' }
      const opt = (key: string) => (typeof input[key] === 'string' && input[key] ? [String(input[key])] : undefined)
      const result = await searchLibraries(canvases, {
        query: String(input.query ?? ''),
        filters: { kind: opt('kind'), category: opt('category'), tag: opt('tag'), source: opt('source') },
        includeDrafts: input.include_drafts === true,
        limit: Math.min(Number(input.limit) || 20, 50),
        cursor: typeof input.cursor === 'string' ? input.cursor : undefined,
      })
      return {
        ok: true,
        data: {
          total: result.total,
          hits: result.hits.map((hit) => ({
            library_id: hit.libraryId,
            library: hit.libraryName,
            ...brief(hit.libraryId, hit.item),
            variant_count: hit.variantCount,
            variants: hit.variants.map((v) => brief(hit.libraryId, v)),
          })),
          facets: {
            kind: result.facets.kind.slice(0, 12),
            category: result.facets.category.slice(0, 12),
          },
          ...(result.cursor ? { cursor: result.cursor } : {}),
        },
        ...(result.hits.length
          ? {}
          : { note: 'Nothing matched. Try fewer or broader words, or get_library for the categories.' }),
      }
    },
  },
  {
    name: 'get_library_item',
    title: 'Read a library item',
    description:
      'One library item with its variants, its family, where it comes from (source and licence) and any rule findings. With include_html, the HTML of the frame that holds it. ' +
      FAMILY,
    readOnly: true,
    shape: {
      library_id: LIBRARY_ID,
      item_id: z.string().describe('Item id from search_library, e.g. "cp.scb-otp-input"'),
      include_html: z.boolean().optional().describe('Also return the HTML of the frame holding the item'),
    },
    async run(input, context) {
      const libraryId = String(input.library_id ?? '')
      const canvas = await readable(context, libraryId)
      if (!canvas) return missing(libraryId)
      const role = libraryRole(context.userId, canvas) ?? 'read'
      const out = await itemDetail(canvas, String(input.item_id ?? ''), role)
      if (!out) return { ok: false, error: `no item "${String(input.item_id)}" in this library` }
      const { detail } = out
      const data: Record<string, unknown> = {
        library_id: canvas.id,
        library: canvas.name,
        ...brief(canvas.id, detail.item),
        description: detail.item.description || undefined,
        source_url: detail.item.sourceUrl ?? undefined,
        license: detail.item.license ?? undefined,
        findings: detail.item.findings.length ? detail.item.findings : undefined,
        frame_id: detail.item.frameId,
        family: detail.family ? brief(canvas.id, detail.family) : undefined,
        variants: detail.variants.map((v) => brief(canvas.id, v)),
      }
      if (input.include_html === true) {
        const shot = await snapshotItem(out.item)
        if (!shot) return { ok: false, error: 'the item is gone' }
        data.html = libraryBlock(shot.snap, { ref: refId(out.item.itemId), libraryId: canvas.id, rev: out.item.rev })
        data.fidelity = shot.fidelity
        return {
          ok: true,
          data,
          note: 'html is the item as a block ready to drop into a frame: its markup with only the CSS it uses, scoped to the block. Prefer insert_library_item, which places it for you.',
        }
      }
      return { ok: true, data }
    },
  },
]

DESIGN_LIBRARY_TOOLS.push({
  name: 'insert_library_item',
  title: 'Insert a library item',
  description:
    'Put a library item (a family or one of its variants) into a frame as a scoped copy: its markup with only the CSS it uses, after an element or at the end of the body. Use it instead of redrawing a pattern search_library found; then adapt the copy to the frame. ' +
    FAMILY,
  readOnly: false,
  shape: {
    canvas_id: z.string().describe('The canvas of the frame to insert into'),
    frame_id: z.string().describe('The frame to insert into'),
    library_id: LIBRARY_ID,
    item_id: z.string().describe('Item id from search_library'),
    after_element_id: z.string().optional().describe('Insert right after the element with this data-doop-id'),
  },
  async run(input, context) {
    const canvasId = String(input.canvas_id ?? '')
    const frameId = String(input.frame_id ?? '')
    const libraryId = String(input.library_id ?? '')
    if (context.canvas && canvasId !== context.canvas.id) {
      return { ok: false, error: 'this run can only insert into its own canvas' }
    }
    const frame = store.getFrame(frameId)
    if (!frame || frame.canvasId !== canvasId || !context.canEdit(canvasId)) {
      return { ok: false, error: `no frame "${frameId}" you can edit on canvas ${canvasId}` }
    }
    const canvas = await readable(context, libraryId)
    if (!canvas) return missing(libraryId)
    const out = await itemDetail(canvas, String(input.item_id ?? ''), libraryRole(context.userId, canvas) ?? 'read')
    if (!out) return { ok: false, error: `no item "${String(input.item_id)}" in this library` }
    try {
      const done = await insertItem({
        item: out.item,
        frameId,
        ...(typeof input.after_element_id === 'string' && input.after_element_id
          ? { afterElementId: input.after_element_id }
          : {}),
        actor: context.actor,
      })
      return {
        ok: true,
        frames: [frameId],
        data: {
          element_id: done.elementId,
          fidelity: done.fidelity,
          frame_id: frameId,
          approval_withdrawn: done.approvalWithdrawn || undefined,
        },
        note: `Inserted as [data-doop-id="${done.elementId}"]. Adapt it to this frame's tokens and content with edit_frame_html; keep its data-doop-ref, data-doop-ref-lib and data-doop-ref-rev attributes. ${done.fidelity === 'static' ? 'It was read from the HTML (no renderer), so check it with a screenshot.' : ''}`.trim(),
      }
    } catch (error) {
      if (error instanceof InsertError) return { ok: false, error: error.message }
      throw error
    }
  },
})

/** The refusal when the instance keeps library writes to people. */
export const LIBRARY_WRITES_REFUSAL =
  'libraries on this instance are curated by people (AGENT_LIBRARY_WRITES=false); propose the item in a comment instead'

/** A write tool's library: the flag, the caller's curate role, and for a
 *  resident run, its own canvas. */
async function writableLibrary(
  context: LibraryToolContext,
  libraryId: string,
): Promise<{ ok: true; canvas: Canvas } | { ok: false; error: string }> {
  if (!env.AGENT_LIBRARY_WRITES) return { ok: false, error: LIBRARY_WRITES_REFUSAL }
  if (context.canvas && context.canvas.id !== libraryId) {
    return { ok: false, error: "this run's canvas is not that library: a run curates only the library it works on" }
  }
  const canvas = await readable(context, libraryId)
  if (!canvas) return missing(libraryId) as { ok: false; error: string }
  const role = context.canvas?.id === libraryId ? 'curate' : libraryRole(context.userId, canvas)
  if (!libraryAllows(role, 'curate')) {
    return { ok: false, error: 'you may use this library but not change it' }
  }
  return { ok: true, canvas }
}

DESIGN_LIBRARY_TOOLS.push(
  {
    name: 'import_to_library',
    title: 'Add frames to a design library',
    description:
      'Bring up to 20 frames into a design library through its rules: each gets an id, its variants marked, the SVG definitions it points at, a category, a page and a status (a low lint score can keep it a draft). Frames from another canvas are copied, never moved. Always returns the report; with dry_run nothing is written. When authoring library content, mark items with data-doop-item / data-doop-variant. ' +
      'Before importing, every frame is checked against ALL the libraries you can use: one captured from the same page, copied from the same frame, or with the same or nearly the same name and text is NOT imported and comes back under `duplicates` (library, category, item, reason). When that happens, tell the human it already exists (which item, in which library and category) and ask: import anyway (force: true) or add it as a variant of that item (as_variant_of). Call check_library first when you only want to know.',
    readOnly: false,
    shape: {
      library_id: LIBRARY_ID,
      frame_ids: z.array(z.string()).min(1).max(20).describe('Frames to add, from any canvas you can read'),
      category: z.string().optional().describe('Put them in this category, over every rule'),
      tags: z.array(z.string()).max(12).optional(),
      dry_run: z.boolean().optional().describe('Report what would happen, write nothing'),
      force: z.boolean().optional().describe('Import even what a library already holds (after the human said so)'),
      as_variant_of: z
        .string()
        .optional()
        .describe('Add the frames as variants of this family id of the target library (after the human said so)'),
    },
    async run(input, context) {
      const libraryId = String(input.library_id ?? '')
      const allowed = await writableLibrary(context, libraryId)
      if (!allowed.ok) return allowed
      const frameIds = Array.isArray(input.frame_ids) ? (input.frame_ids as unknown[]).map(String).slice(0, 20) : []
      for (const frameId of frameIds) {
        const frame = store.getFrame(frameId)
        const from = frame && store.getCanvas(frame.canvasId)
        if (!from || !(context.canRead?.(from.id) ?? libraryRole(context.userId, from) !== null)) {
          return { ok: false, error: `no frame "${frameId}" you can read` }
        }
      }
      let outcome: Awaited<ReturnType<typeof runImport>>
      try {
        outcome = await runImport({
          libraryId,
          frameIds,
          ...(typeof input.category === 'string' ? { category: input.category } : {}),
          ...(Array.isArray(input.tags) ? { tags: (input.tags as unknown[]).map(String) } : {}),
          dryRun: input.dry_run === true,
          actor: context.actor,
          libraries: await context.libraries(),
          force: input.force === true,
          ...(typeof input.as_variant_of === 'string' && input.as_variant_of
            ? { asVariantOf: input.as_variant_of }
            : {}),
        })
      } catch (error) {
        if (error instanceof ImportRefusal) return { ok: false, error: error.message }
        throw error
      }
      const dupes = outcome.report.duplicates ?? []
      return {
        ok: true,
        ...(dupes.length
          ? {
              note: `Not imported, already in a library: ${dupes
                .map((d) => `"${d.name}" is ${describeMatches(d.matches.slice(0, 1))}`)
                .join(
                  '; ',
                )}. Tell the human it already exists, then import again with force: true or as_variant_of only if they ask for it.`,
            }
          : {}),
        data: {
          duplicates: dupes.length
            ? dupes.map((d) => ({ frame_id: d.frameId, name: d.name, already_in: d.matches.map(matchBrief) }))
            : undefined,
          dry_run: input.dry_run === true,
          totals: outcome.report.totals,
          frames: outcome.report.frames.map((f) => ({
            frame_id: f.frameId,
            item_id: f.item?.itemId,
            status: f.item?.status,
            category: f.item?.category,
            variants: f.variants,
            ignored: f.ignored || undefined,
            findings: f.findings.map((x) => `${x.kind}: ${x.message}`),
          })),
          applied: outcome.applied,
        },
        frames: outcome.applied.flatMap((a) => (a.libraryFrameId ? [a.libraryFrameId] : [])),
      }
    },
  },
  {
    name: 'set_library_item',
    title: 'Curate a library item',
    description:
      'Change what people see of one library item without touching its HTML: its label, description, category, tags or status (active accepts a draft; deprecated sinks it in search; hidden takes it out).',
    readOnly: false,
    shape: {
      library_id: LIBRARY_ID,
      item_id: z.string(),
      label: z.string().max(200).optional(),
      description: z.string().max(2000).optional(),
      category: z.string().max(200).optional(),
      tags: z.array(z.string()).max(12).optional(),
      status: z.enum(['active', 'deprecated', 'hidden']).optional(),
    },
    async run(input, context) {
      const libraryId = String(input.library_id ?? '')
      const allowed = await writableLibrary(context, libraryId)
      if (!allowed.ok) return allowed
      const out = await itemDetail(allowed.canvas, String(input.item_id ?? ''), 'curate')
      if (!out) return { ok: false, error: `no item "${String(input.item_id)}" in this library` }
      const cleaned = cleanItemPatch(input)
      if (!cleaned.ok) return { ok: false, error: cleaned.error }
      await patchItem(libraryId, out.item.itemId, cleaned.patch, context.actor.name)
      const after = await itemDetail(allowed.canvas, out.item.itemId, 'curate')
      return { ok: true, data: after ? brief(libraryId, after.detail.item) : null }
    },
  },
)

function matchBrief(m: DuplicateMatch) {
  return {
    library_id: m.libraryId,
    library: m.libraryName,
    category: m.category,
    item_id: m.itemId,
    name: m.name,
    reason: m.reason,
    score: m.score,
    url: m.url,
  }
}

DESIGN_LIBRARY_TOOLS.push({
  name: 'check_library',
  title: 'Check whether a library already has something',
  description:
    'Ask "do we already have this?" before importing: give a frame (frame_id), a page address (url), or a name and some of its text, and get the items of every library you can use that it would duplicate: the same page (same-url), the same design (same-content) or one with nearly the same name and text (similar, with a score). Read-only. When something matches, tell the human where it already is instead of importing a second copy.',
  readOnly: true,
  shape: {
    frame_id: z.string().optional().describe('A frame you can read, about to be imported'),
    url: z.string().max(2000).optional().describe('The page it comes from'),
    name: z.string().max(200).optional(),
    text: z.string().max(2000).optional().describe('Some of its visible text'),
  },
  async run(input, context) {
    const frameId = typeof input.frame_id === 'string' ? input.frame_id : ''
    const name = typeof input.name === 'string' ? input.name : ''
    let candidate: DuplicateCandidate = {
      name,
      ...(typeof input.url === 'string' && input.url ? { url: input.url } : {}),
      ...(typeof input.text === 'string' && input.text ? { text: input.text } : {}),
    }
    if (frameId) {
      const frame = store.getFrame(frameId)
      const from = frame && store.getCanvas(frame.canvasId)
      if (!from || !(context.canRead?.(from.id) ?? libraryRole(context.userId, from) !== null)) {
        return { ok: false, error: `no frame "${frameId}" you can read` }
      }
      const full = await store.renderableFrame(frameId)
      candidate = { ...candidate, name: name || frame!.name, html: full?.html ?? '', ref: `${from.id}:${frameId}` }
    }
    if (!candidate.name && !candidate.url && !candidate.html) {
      return { ok: false, error: 'give a frame_id, a url, or a name and some text' }
    }
    const [matches = []] = await findDuplicates([candidate], await context.libraries())
    return {
      ok: true,
      data: { duplicates: matches.map(matchBrief) },
      note: matches.length
        ? `Already there: ${describeMatches(matches.slice(0, 3))}. Tell the human instead of importing a second copy.`
        : 'Nothing like it in your libraries.',
    }
  },
})

/** A curation as an agent reads it: the job and, once proposed, the tree
 *  with counts and a few item names per category. */
function curationBrief(job: CurationJob) {
  const view = job.plan ? planView(job.plan, 3) : null
  const tree = (nodes: CurationCategoryView[]): unknown[] =>
    nodes.map((n) => ({
      id: n.id,
      path: n.path,
      items: n.count,
      examples: n.samples.map((s) => s.label),
      ...(n.children.length ? { children: tree(n.children) } : {}),
    }))
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    progress: job.progress,
    error: job.error ?? undefined,
    model_calls: job.calls,
    canvas_id: job.applied?.canvasId ?? undefined,
    ...(view && job.plan!.tree.length
      ? { totals: view.totals, fallback: view.fallback || undefined, categories: tree(view.tree) }
      : {}),
  }
}

DESIGN_LIBRARY_TOOLS.push(
  {
    name: 'start_library_curation',
    title: 'Organise canvases into one library with AI',
    description:
      "Start an AI curation: read 1 to 8 canvases the human manages, fold their duplicates, propose one category tree from the items themselves and file every item in it. It runs in the background on the human's own model account (about one call per 60 frames) and writes nothing but the proposal: the human reviews and edits it, then creates the library from the Libraries page (Organise with AI). Follow it with get_library_curation. Start one only when the human asks for it.",
    readOnly: false,
    shape: {
      canvas_ids: z.array(z.string()).min(1).max(8).describe('The source canvases, in the order duplicates are kept'),
      name: z
        .string()
        .max(120)
        .optional()
        .describe('Name of the library it will create; "<first canvas> (curated)" by default'),
    },
    async run(input, context) {
      if (!context.userId)
        return { ok: false, error: 'a curation runs for a signed-in person; none is behind this call' }
      const ids = Array.isArray(input.canvas_ids) ? (input.canvas_ids as unknown[]).map(String) : []
      try {
        const job = await startCuration({
          ownerId: context.userId,
          sourceIds: ids,
          ...(typeof input.name === 'string' && input.name.trim() ? { name: input.name } : {}),
        })
        return {
          ok: true,
          data: curationBrief(job),
          note: 'Started. Check it with get_library_curation; tell the human to review it in Libraries, Organise with AI, once it is ready.',
        }
      } catch (error) {
        if (error instanceof CurationError) return { ok: false, error: error.message }
        throw error
      }
    },
  },
  {
    name: 'get_library_curation',
    title: 'Read an AI library curation',
    description:
      "An AI curation of the human's canvases: its status (gathering, proposing, classifying, ready, applying, applied, failed), progress and, once proposed, the category tree with item counts and example item names, the duplicates folded and the items left unclassified. Without curation_id, lists the human's curations. Read-only: the human edits and applies the plan.",
    readOnly: true,
    shape: { curation_id: z.string().optional() },
    async run(input, context) {
      if (!context.userId) return { ok: false, error: 'no signed-in person is behind this call' }
      if (typeof input.curation_id !== 'string' || !input.curation_id) {
        return { ok: true, data: { curations: curationsOf(context.userId).map((j) => jobView(j)) } }
      }
      const job = getCuration(input.curation_id)
      if (!job || job.ownerId !== context.userId) return { ok: false, error: `no curation "${input.curation_id}"` }
      return { ok: true, data: curationBrief(job) }
    },
  },
)

export const DESIGN_LIBRARY_TOOL_NAMES = DESIGN_LIBRARY_TOOLS.map((tool) => tool.name)

/** Run a library tool by name. */
export async function runLibraryTool(
  name: string,
  input: Record<string, unknown>,
  context: LibraryToolContext,
): Promise<LibraryToolResult> {
  const tool = DESIGN_LIBRARY_TOOLS.find((candidate) => candidate.name === name)
  if (!tool) return { ok: false, error: `unknown tool ${name}` }
  return tool.run(input, context)
}

/** The `# Libraries` brief for a prompt: each library's name, counts,
 *  kinds and top ten categories, from its index state (no html). */
export function designLibrariesBrief(canvasIds: string[]): string {
  const lines: string[] = []
  for (const id of canvasIds) {
    const record = getLibrary(id)
    const canvas = store.getCanvas(id)
    if (!record || !canvas) continue
    const kinds = record.taxonomy.kinds.map((k) => k.id).join(', ')
    const categories = record.taxonomy.categories
      .slice(0, 10)
      .map((c) => c.path)
      .join('; ')
    lines.push(
      `- "${canvas.name}" (${id}): ${record.counts.items} families, ${record.counts.variants} variants` +
        (kinds ? `; kinds ${kinds}` : '') +
        (categories ? `; categories ${categories}` : ''),
    )
  }
  if (!lines.length) return ''
  return `# Libraries\nDesign libraries you can search (search_library) and insert from (insert_library_item):\n${lines.join('\n')}`
}

/** The libraries one account may use, as canvases. */
export async function librariesOf(userId: string | undefined, extra?: Canvas): Promise<Canvas[]> {
  const entries = userId ? await readableLibraries(userId) : []
  const out = entries.flatMap((e) => store.getCanvas(e.id) ?? [])
  if (extra && getLibrary(extra.id) && !out.some((c) => c.id === extra.id)) out.push(extra)
  return out
}
