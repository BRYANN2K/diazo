/**
 * The design-library tools every agent gets, over MCP (server/mcp.ts) and in
 * the resident agent (server/resident.ts): one schema and one handler each,
 * under the same names, so the two cannot drift. A library the account
 * cannot read answers exactly like one that does not exist.
 * Spec: .context/specs/design-libraries.md, "Agent tools".
 */
import { z } from 'zod'
import type { Actor, Canvas } from '../shared/types.ts'
import type { LibraryItemSummary } from '../shared/library.ts'
import { describeRules, NON_INSERTABLE_KINDS } from '../shared/libraryRules.ts'
import { store } from './store.ts'
import { getLibrary, libraryRole } from './libraries.ts'
import { libraryItems } from './libraryIndex.ts'
import { itemDetail, itemUrl, readableLibraries, searchLibraries } from './libraryQueries.ts'
import { insertItem, InsertError, snapshotItem } from './librarySnapshot.ts'
import { libraryBlock, refId } from '../shared/libraryBlock.ts'

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

/** The libraries one account may use, as canvases. */
export async function librariesOf(userId: string | undefined, extra?: Canvas): Promise<Canvas[]> {
  const entries = userId ? await readableLibraries(userId) : []
  const out = entries.flatMap((e) => store.getCanvas(e.id) ?? [])
  if (extra && getLibrary(extra.id) && !out.some((c) => c.id === extra.id)) out.push(extra)
  return out
}
