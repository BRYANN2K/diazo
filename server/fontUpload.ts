import { MAX_FONT_BYTES, fontStack, type CustomFont, type FontScope } from '../shared/fonts.ts'
import { createUploadTicket, fetchRemote } from './assets.ts'
import { env } from './env.ts'
import { FontInputError, addFont, canUseScope } from './fonts.ts'

/**
 * MCP upload_font: an agent adds a face to a font library through the same
 * pipeline as Settings → Fonts (server/fonts.ts). The library is the one a
 * canvas designs with (its workspace's, else its owner's own, as
 * `GET /api/canvases/:id/fonts` reads it) or a named workspace's, and only
 * someone who may change that library over REST may add to it.
 */

export interface UploadFontInput {
  source_url?: string
  local_file?: boolean
  data?: string
  file_name?: string
  canvas_id?: string
  workspace_id?: string
}

export interface UploadFontContext {
  /** the connected account; fonts need one, since a library belongs to people */
  user?: { id: string; name: string }
  /** the canvas, when this account may edit it */
  canvasFor: (canvasId: string) => { workspaceId?: string; ownerId?: string } | undefined
}

export type UploadFontOutcome = { ok: true; data: Record<string, unknown> } | { ok: false; error: string }

const refuse = (error: string): UploadFontOutcome => ({ ok: false, error })

/** The library an upload lands in, or why this account may not add to it. */
export function fontLibraryFor(input: UploadFontInput, ctx: UploadFontContext): FontScope | string {
  const userId = ctx.user?.id
  if (!userId) return 'fonts belong to a person or a workspace — connect with a signed-in account to upload one'
  if (!!input.canvas_id === !!input.workspace_id)
    return "name the library: canvas_id (the library that canvas designs with) or workspace_id (a workspace's)"
  if (input.workspace_id) {
    const scope = { workspaceId: input.workspace_id }
    return canUseScope(scope, userId) ? scope : `no workspace with id ${input.workspace_id} this account is a member of`
  }
  const canvas = ctx.canvasFor(input.canvas_id!)
  if (!canvas) return `no canvas with id ${input.canvas_id} this account can edit`
  if (canvas.workspaceId) {
    const scope = { workspaceId: canvas.workspaceId }
    return canUseScope(scope, userId)
      ? scope
      : "this canvas designs with its workspace's font library, and only the workspace's members can add to it"
  }
  return canvas.ownerId === userId
    ? { personal: true }
    : "this canvas designs with its owner's personal font library, and only its owner can add to it — ask them, or move the canvas into a workspace"
}

/** What the agent needs to use a face it just added. */
export function fontUploaded(font: CustomFont, scope: FontScope): Record<string, unknown> {
  const css = `font-family: ${fontStack(font.family)};`
  return {
    ok: true,
    family: font.family,
    weight: font.weight,
    style: font.style,
    format: font.format,
    url: font.url,
    library: 'workspaceId' in scope ? { workspace_id: scope.workspaceId } : 'personal',
    css,
    note:
      `Use it by naming the family in frame CSS (${css}) and nothing more: Doop adds the @font-face rule to every ` +
      `frame that names it, on the canvases using this library, in a <style data-doop-fonts> block you keep. Do not ` +
      `write the @font-face yourself or load the family from Google Fonts. Upload one file per weight and style; a ` +
      `file for a face the library already has (same family, weight and style) replaces it.`,
  }
}

function fileNameFromUrl(raw: string): string {
  try {
    return decodeURIComponent(new URL(raw).pathname.split('/').pop() ?? '')
  } catch {
    return ''
  }
}

/** Add a face from a URL or base64, or hand out a one-time upload ticket for a local file. */
export async function runUploadFont(input: UploadFontInput, ctx: UploadFontContext): Promise<UploadFontOutcome> {
  const provided = [input.data, input.source_url, input.local_file].filter(Boolean).length
  if (provided !== 1)
    return refuse(
      'provide exactly one of: source_url (remote file), local_file=true (local file — returns a curl command), or data (small base64)',
    )
  const scope = fontLibraryFor(input, ctx)
  if (typeof scope === 'string') return refuse(scope)
  const user = ctx.user!
  if (input.local_file) {
    const { token, expiresAt } = createUploadTicket({
      canvasId: input.canvas_id,
      ownerId: user.id,
      uploadedBy: user.name,
      font: { scope, user, fileName: input.file_name ?? '' },
    })
    const upload_url = `${env.BETTER_AUTH_URL}/u/${token}`
    return {
      ok: true,
      data: {
        ok: true,
        upload_url,
        command: `curl -sS -T "<path-to-your-font-file>" ${upload_url}`,
        expires_at: new Date(expiresAt).toISOString(),
        note: 'One-time upload URL (single use, 15 min, TTF/OTF/WOFF/WOFF2 up to 10 MB). Run the curl command in your shell with your real file path — its JSON response names the family, weight and style and the CSS to use. Request a fresh ticket for each file.',
      },
    }
  }
  let buf: Buffer
  try {
    buf = input.data
      ? Buffer.from(input.data.replace(/^data:[^,]*;base64,/, ''), 'base64')
      : await fetchRemote(input.source_url!, MAX_FONT_BYTES)
  } catch (e) {
    return refuse(e instanceof Error ? e.message : 'the font could not be fetched')
  }
  const fileName = input.file_name ?? (input.source_url ? fileNameFromUrl(input.source_url) : '')
  try {
    return { ok: true, data: fontUploaded(await addFont(scope, user, buf, fileName), scope) }
  } catch (e) {
    if (e instanceof FontInputError) return refuse(e.message)
    console.error('[fonts] agent upload failed', e)
    return refuse('the font could not be saved — try again')
  }
}
