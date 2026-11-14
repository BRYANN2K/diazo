/**
 * Pull a library canvas from one Doop into another.
 *
 *   DOOP_FROM_KEY=dpk_… DOOP_TO_KEY=dpk_… \
 *     npx tsx scripts/pull-library.ts --from https://doop.design --canvas <id> --to https://redoop.example [--dry-run]
 *
 * The keys are agent keys (Settings → Agent keys) read from the environment
 * only, never written anywhere. The source is only read: its MCP read tools
 * (get_canvas, get_frame) and its public /a/ assets, all GETs but the MCP
 * calls themselves. REST does not take agent keys, which is why reads go
 * through /mcp. The target gets a new canvas with the same pages (names and
 * order), and on each page the same frames (names, positions, sizes, HTML);
 * every /a/ asset a frame names is fetched from the source and uploaded to
 * the target, and the frame's HTML points at the new URL.
 *
 * Resumable: what was created is written after every step to a progress file
 * in the OS temp directory (keyed by the two origins and the canvas), so a
 * rerun picks up where the last one stopped and creates nothing twice.
 * --dry-run reads the source and says what it would create.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export interface PullOptions {
  from: string
  to: string
  canvas: string
  fromKey: string
  toKey: string
  dryRun?: boolean
  /** where the progress file lives (the OS temp dir by default) */
  stateDir?: string
  fetch?: typeof fetch
  log?: (line: string) => void
}

export interface PullProgress {
  canvasId?: string
  /** source page id → target page id */
  pages: Record<string, string>
  /** source frame id → target frame id */
  frames: Record<string, string>
  /** source asset path → target URL */
  assets: Record<string, string>
  /** the target's page list has been set to the source's names and order */
  pagesNamed?: boolean
}

export interface PullReport {
  canvasId: string | null
  pages: number
  frames: number
  assets: number
  created: { pages: number; frames: number; assets: number }
  progressFile: string
}

interface SourcePage {
  id: string
  name: string
}
interface SourceFrame {
  id: string
  name: string
  pageId?: string
  x: number
  y: number
  width: number
  height: number
}

const AGENT = 'pull-library'
/** /a/<id>.<ext>, absolute on the source origin or relative */
const ASSET_PATH = /\/a\/[A-Za-z0-9_-]+\.[A-Za-z0-9]+/g

function origin(url: string): string {
  return new URL(url).origin
}

export function progressFileOf(opts: Pick<PullOptions, 'from' | 'to' | 'canvas' | 'stateDir'>): string {
  const key = createHash('sha1')
    .update(`${origin(opts.from)}|${opts.canvas}|${origin(opts.to)}`)
    .digest('hex')
    .slice(0, 16)
  return path.join(opts.stateDir ?? tmpdir(), `doop-pull-library-${key}.json`)
}

function readProgress(file: string): PullProgress {
  if (!existsSync(file)) return { pages: {}, frames: {}, assets: {} }
  return JSON.parse(readFileSync(file, 'utf8')) as PullProgress
}

function writeProgress(file: string, progress: PullProgress): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(progress, null, 2))
}

/** One MCP tool call over plain HTTP (the server is stateless). */
function mcpClient(base: string, key: string, doFetch: typeof fetch) {
  let id = 0
  return async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(`${origin(base)}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
      })
      if (!res.ok) throw new Error(`${name} on ${origin(base)}: HTTP ${res.status}`)
      const raw = await res.text()
      const json = raw.trimStart().startsWith('{')
        ? raw
        : (raw
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .pop() ?? '')
      const message = JSON.parse(json) as {
        result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> }
        error?: { message: string }
      }
      if (message.error) throw new Error(`${name}: ${message.error.message}`)
      const textOut = message.result?.content?.find((c) => c.type === 'text')?.text ?? ''
      if (message.result?.isError) {
        /* the target's upload meter: wait for the minute to pass */
        if (/rate limit/i.test(textOut) && attempt < 5) {
          await new Promise((r) => setTimeout(r, 15_000))
          continue
        }
        throw new Error(`${name}: ${textOut}`)
      }
      return JSON.parse(textOut) as T
    }
  }
}

export async function pullLibrary(opts: PullOptions): Promise<PullReport> {
  const doFetch = opts.fetch ?? fetch
  const log = opts.log ?? (() => {})
  const source = mcpClient(opts.from, opts.fromKey, doFetch)
  const target = mcpClient(opts.to, opts.toKey, doFetch)
  const file = progressFileOf(opts)
  const progress = readProgress(file)
  const save = () => {
    if (!opts.dryRun) writeProgress(file, progress)
  }
  const created = { pages: 0, frames: 0, assets: 0 }

  const top = await source<{ name: string; pages: SourcePage[] }>('get_canvas', {
    canvas_id: opts.canvas,
    agent_name: AGENT,
  })
  const pages = top.pages
  log(`${top.name}: ${pages.length} pages`)

  if (!progress.canvasId && !opts.dryRun) {
    const made = await target<{ id: string }>('create_canvas', { name: top.name, agent_name: AGENT })
    progress.canvasId = made.id
    save()
    log(`created canvas ${made.id}`)
  }

  /* pages: the new canvas's first page stands for the source's first */
  let firstTargetPage: string | undefined
  if (progress.canvasId && !opts.dryRun) {
    const current = await target<{ pages: SourcePage[] }>('get_canvas', {
      canvas_id: progress.canvasId,
      agent_name: AGENT,
    })
    firstTargetPage = current.pages[0]?.id
  }
  for (const [i, page] of pages.entries()) {
    if (progress.pages[page.id]) continue
    created.pages++
    if (opts.dryRun) continue
    if (i === 0 && firstTargetPage && !Object.values(progress.pages).includes(firstTargetPage)) {
      progress.pages[page.id] = firstTargetPage
    } else {
      const made = await target<{ page: SourcePage }>('create_canvas_page', {
        canvas_id: progress.canvasId,
        name: page.name,
        agent_name: AGENT,
      }).catch((error: unknown) => {
        /* a canvas holds 100 pages, a library 1,000: past 100 the target
           must be turned into a library first (people only), then rerun */
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} — if the page cap was reached, turn canvas ${progress.canvasId} into a library (File → Turn into a library) and run the command again`,
        )
      })
      progress.pages[page.id] = made.page.id
    }
    save()
  }
  if (!opts.dryRun && progress.canvasId && !progress.pagesNamed) {
    const current = await target<{ pages: SourcePage[] }>('get_canvas', {
      canvas_id: progress.canvasId,
      agent_name: AGENT,
    })
    await target('set_canvas_pages', {
      canvas_id: progress.canvasId,
      expectedPages: current.pages.map((p) => ({ id: p.id, name: p.name })),
      pages: pages.map((p) => ({ id: progress.pages[p.id]!, name: p.name })),
      agent_name: AGENT,
    })
    progress.pagesNamed = true
    save()
  }

  let frameCount = 0
  const assetPaths = new Set<string>()
  for (const page of pages) {
    const listed = await source<{ frames: SourceFrame[] }>('get_canvas', {
      canvas_id: opts.canvas,
      page_id: page.id,
      agent_name: AGENT,
    })
    for (const frame of listed.frames) {
      frameCount++
      if (progress.frames[frame.id]) continue
      const full = await source<{ html: string }>('get_frame', {
        frame_id: frame.id,
        expand_components: true,
        agent_name: AGENT,
      })
      let html = full.html
      const named = new Set(
        [...html.matchAll(new RegExp(`(?:${escapeRe(origin(opts.from))})?${ASSET_PATH.source}`, 'g'))].map((m) => m[0]),
      )
      for (const ref of named) {
        const assetPath = ref.slice(ref.indexOf('/a/'))
        assetPaths.add(assetPath)
        if (!progress.assets[assetPath]) {
          created.assets++
          if (opts.dryRun) continue
          progress.assets[assetPath] = await copyAsset(assetPath)
          save()
        }
        html = html.split(ref).join(progress.assets[assetPath]!)
      }
      created.frames++
      if (opts.dryRun) continue
      const made = await target<{ frame: { id: string } }>('create_frame', {
        canvas_id: progress.canvasId,
        pageId: progress.pages[page.id],
        name: frame.name,
        html,
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
        agent_name: AGENT,
      })
      progress.frames[frame.id] = made.frame.id
      save()
      log(`${page.name} / ${frame.name}`)
    }
  }

  async function copyAsset(assetPath: string): Promise<string> {
    const res = await doFetch(`${origin(opts.from)}${assetPath}`)
    if (!res.ok) throw new Error(`asset ${assetPath}: HTTP ${res.status}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    const ticket = await target<{ upload_url: string }>('upload_asset', {
      canvas_id: progress.canvasId,
      local_file: true,
      agent_name: AGENT,
    })
    const put = await doFetch(ticket.upload_url, { method: 'PUT', body: bytes })
    if (!put.ok) throw new Error(`upload of ${assetPath}: HTTP ${put.status}`)
    const uploaded = (await put.json()) as { url: string }
    return uploaded.url
  }

  return {
    canvasId: progress.canvasId ?? null,
    pages: pages.length,
    frames: frameCount,
    assets: assetPaths.size,
    created,
    progressFile: file,
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseArgs(argv: string[]): Pick<PullOptions, 'from' | 'to' | 'canvas' | 'dryRun'> {
  const value = (flag: string) => {
    const i = argv.indexOf(flag)
    const v = i >= 0 ? argv[i + 1] : undefined
    if (!v) throw new Error(`missing ${flag}`)
    return v
  }
  return { from: value('--from'), to: value('--to'), canvas: value('--canvas'), dryRun: argv.includes('--dry-run') }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const fromKey = process.env.DOOP_FROM_KEY
  const toKey = process.env.DOOP_TO_KEY
  if (!fromKey || (!toKey && !args.dryRun)) throw new Error('set DOOP_FROM_KEY and DOOP_TO_KEY in the environment')
  const report = await pullLibrary({ ...args, fromKey, toKey: toKey ?? '', log: (l) => console.log(l) })
  console.log(JSON.stringify(report, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
