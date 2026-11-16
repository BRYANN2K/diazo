/* The Agents-tab composer's unsent text, parked per canvas in the browser.

   The live draft lives in the store (`composerDrafts`), which a reload, a
   hard navigation or a desktop relaunch forgets; this module mirrors it
   into localStorage under `doop:composer-draft:<canvasId>` so the composer
   gets its text back on the next mount. Writes are debounced — a keystroke
   is not worth a storage hit — while clearing is immediate, so a queued
   card's draft cannot resurrect from a write still inside the window. Each
   write also prunes: parked drafts are a scratchpad, not an archive, so
   entries older than 30 days or beyond the 50 most recent canvases go. */

const KEY_PREFIX = 'doop:composer-draft:'

/** a parked draft dies after this long */
const MAX_DRAFT_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** at most this many canvases keep a parked draft */
const MAX_KEPT_DRAFTS = 50
/** keystrokes inside this window batch into one write */
const WRITE_DEBOUNCE_MS = 400

interface ParkedDraft {
  text: string
  /** last time the draft was touched, for the age and count prunes */
  at: number
}

/* writes still inside their debounce window, per canvas — a read takes
   them over the stored copy, and a clear must cancel them */
const pending = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>()

function draftKey(canvasId: string): string {
  return `${KEY_PREFIX}${canvasId}`
}

function readParked(raw: string | null): ParkedDraft | null {
  if (raw === null) return null
  try {
    const stored: unknown = JSON.parse(raw)
    const draft = stored && typeof stored === 'object' ? (stored as Partial<ParkedDraft>) : null
    return typeof draft?.text === 'string' && draft.text && typeof draft.at === 'number'
      ? { text: draft.text, at: draft.at }
      : null
  } catch {
    return null
  }
}

/** The draft parked for a canvas, or null when there is none worth keeping.
 *  A write still inside the debounce window counts — it is the freshest
 *  copy. Malformed, empty and expired entries read as absent. */
export function readComposerDraft(canvasId: string): string | null {
  const queued = pending.get(canvasId)
  if (queued) return queued.text
  try {
    const draft = readParked(localStorage.getItem(draftKey(canvasId)))
    if (draft && Date.now() - draft.at <= MAX_DRAFT_AGE_MS) return draft.text
    return null
  } catch {
    return null
  }
}

/** Park the draft, WRITE_DEBOUNCE_MS after the last keystroke. The write
 *  pass prunes the parked set at the same time. An empty text is a clear,
 *  not a write — no point parking a blank. */
export function writeComposerDraft(canvasId: string, text: string): void {
  if (!text) {
    clearComposerDraft(canvasId)
    return
  }
  const queued = pending.get(canvasId)
  if (queued) clearTimeout(queued.timer)
  const timer = setTimeout(() => {
    pending.delete(canvasId)
    try {
      localStorage.setItem(draftKey(canvasId), JSON.stringify({ text, at: Date.now() } satisfies ParkedDraft))
      pruneComposerDrafts()
    } catch {
      /* blocked or full storage: the draft lives on in memory only */
    }
  }, WRITE_DEBOUNCE_MS)
  pending.set(canvasId, { text, timer })
}

/** The card queued, or the field was emptied: the parked copy goes at once,
 *  including a write still inside the debounce window. */
export function clearComposerDraft(canvasId: string): void {
  const queued = pending.get(canvasId)
  if (queued) {
    clearTimeout(queued.timer)
    pending.delete(canvasId)
  }
  try {
    localStorage.removeItem(draftKey(canvasId))
  } catch {
    /* blocked storage: nothing to clear */
  }
}

/** Land every debounced write now — called on `pagehide` so the last
 *  keystrokes before a reload or a desktop relaunch are not lost. */
export function flushComposerDrafts(): void {
  for (const [canvasId, queued] of pending) {
    clearTimeout(queued.timer)
    pending.delete(canvasId)
    try {
      localStorage.setItem(draftKey(canvasId), JSON.stringify({ text: queued.text, at: Date.now() }))
    } catch {
      /* blocked or full storage */
    }
  }
}

/** Drop unreadable, empty and over-age entries, then keep only the
 *  MAX_KEPT_DRAFTS most recently touched canvases. Runs inside the
 *  debounced write so it never costs a keystroke. */
export function pruneComposerDrafts(): void {
  let entries: { key: string; at: number }[]
  try {
    entries = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(KEY_PREFIX)) continue
      entries.push({ key, at: readParked(localStorage.getItem(key))?.at ?? 0 })
    }
  } catch {
    return
  }
  const now = Date.now()
  const fresh = (entry: { at: number }) => entry.at > 0 && now - entry.at <= MAX_DRAFT_AGE_MS
  const keep = entries.filter(fresh).sort((a, b) => b.at - a.at)
  for (const { key } of [...entries.filter((e) => !fresh(e)), ...keep.slice(MAX_KEPT_DRAFTS)]) {
    try {
      localStorage.removeItem(key)
    } catch {
      /* a removal that fails only means the entry stays */
    }
  }
}
