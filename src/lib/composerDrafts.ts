/* The Agents-tab composer's unsent text, parked per account and canvas in
   the browser.

   The live draft lives in the store (`composerDrafts`), which a reload, a
   hard navigation or a desktop relaunch forgets; this module mirrors it
   into localStorage under `doop:composer-draft:<userId>:<canvasId>` so the
   composer gets its text back on the next mount. The key carries the
   account (`setComposerDraftOwner`, set by App from the session): a draft
   is someone's unsent words, so the next person signing in on the same
   browser never reads it. Signing out removes every parked draft
   (`purgeComposerDrafts`), and a new account arriving removes the others'.
   With no one signed in nothing is parked.

   Writes are debounced — a keystroke is not worth a storage hit — while
   clearing is immediate, so a queued card's draft cannot resurrect from a
   write still inside the window. Each write prunes first, so a full
   storage gets room back before the write: parked drafts are a
   scratchpad, not an archive, so entries older than 30 days or beyond the
   50 most recent canvases go. A draft longer than MAX_PARKED_CHARS stays
   in memory only. */

const KEY_PREFIX = 'doop:composer-draft:'

/** a parked draft dies after this long */
const MAX_DRAFT_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** at most this many canvases keep a parked draft */
const MAX_KEPT_DRAFTS = 50
/** keystrokes inside this window batch into one write */
const WRITE_DEBOUNCE_MS = 400
/** a draft past this length is not parked: a huge paste is not rewritten
 *  after every typing pause */
export const MAX_PARKED_CHARS = 20_000

interface ParkedDraft {
  text: string
  /** last time the draft was touched, for the age and count prunes */
  at: number
}

/* the signed-in account the parked drafts belong to; null while signed out */
let owner: string | null = null

/* writes still inside their debounce window, per storage key — a read
   takes them over the stored copy, and a clear must cancel them */
const pending = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>()

function draftKey(userId: string, canvasId: string): string {
  return `${KEY_PREFIX}${userId}:${canvasId}`
}

function ownerKey(canvasId: string): string | null {
  return owner ? draftKey(owner, canvasId) : null
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

function parkedKeys(): string[] {
  const keys: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key?.startsWith(KEY_PREFIX)) keys.push(key)
  }
  return keys
}

function store(key: string, text: string): void {
  /* prune first, keeping a seat for this key: when storage is full, the
     room the prune frees is what lets this write land */
  prune(key)
  localStorage.setItem(key, JSON.stringify({ text, at: Date.now() } satisfies ParkedDraft))
}

function removeKeys(keep: (key: string) => boolean): void {
  for (const [key, queued] of pending) {
    if (keep(key)) continue
    clearTimeout(queued.timer)
    pending.delete(key)
  }
  try {
    for (const key of parkedKeys()) if (!keep(key)) localStorage.removeItem(key)
  } catch {
    /* blocked storage: nothing parked to remove */
  }
}

/** Who the parked drafts belong to, from the session (`null` signed out).
 *  A new account removes every draft parked by another one; the session
 *  ending removes them all, as signing out does. Returns whether the
 *  owner changed, so the caller can drop the in-memory drafts too. */
export function setComposerDraftOwner(userId: string | null): boolean {
  if (userId === owner) return false
  const previous = owner
  owner = userId
  if (userId) {
    const mine = `${KEY_PREFIX}${userId}:`
    removeKeys((key) => key.startsWith(mine))
  } else if (previous) {
    purgeComposerDrafts()
  }
  return true
}

/** Sign-out and account deletion: every parked draft goes, whoever wrote
 *  it, including writes still inside their debounce window. */
export function purgeComposerDrafts(): void {
  removeKeys(() => false)
}

/** The draft parked for a canvas by the signed-in account, or null when
 *  there is none worth keeping. A write still inside the debounce window
 *  counts — it is the freshest copy. Malformed, empty and expired entries
 *  read as absent. */
export function readComposerDraft(canvasId: string): string | null {
  const key = ownerKey(canvasId)
  if (!key) return null
  const queued = pending.get(key)
  if (queued) return queued.text
  try {
    const draft = readParked(localStorage.getItem(key))
    if (draft && Date.now() - draft.at <= MAX_DRAFT_AGE_MS) return draft.text
    return null
  } catch {
    return null
  }
}

/** Park the draft, WRITE_DEBOUNCE_MS after the last keystroke. An empty
 *  text is a clear, not a write — no point parking a blank — and so is one
 *  past MAX_PARKED_CHARS, so a shorter parked copy cannot come back in its
 *  place. Signed out, nothing is parked. */
export function writeComposerDraft(canvasId: string, text: string): void {
  if (!text || text.length > MAX_PARKED_CHARS) {
    clearComposerDraft(canvasId)
    return
  }
  const key = ownerKey(canvasId)
  if (!key) return
  const queued = pending.get(key)
  if (queued) clearTimeout(queued.timer)
  const timer = setTimeout(() => {
    pending.delete(key)
    try {
      store(key, text)
    } catch {
      /* blocked or full storage: the draft lives on in memory only */
    }
  }, WRITE_DEBOUNCE_MS)
  pending.set(key, { text, timer })
}

/** The card queued, or the field was emptied: the parked copy goes at once,
 *  including a write still inside the debounce window. */
export function clearComposerDraft(canvasId: string): void {
  const key = ownerKey(canvasId)
  if (!key) return
  const queued = pending.get(key)
  if (queued) {
    clearTimeout(queued.timer)
    pending.delete(key)
  }
  try {
    localStorage.removeItem(key)
  } catch {
    /* blocked storage: nothing to clear */
  }
}

/** Land every debounced write now — called on `pagehide` and when the page
 *  is hidden, so the last keystrokes before a reload, a desktop quit or a
 *  mobile tab kill are not lost. */
export function flushComposerDrafts(): void {
  for (const [key, queued] of pending) {
    clearTimeout(queued.timer)
    pending.delete(key)
    try {
      store(key, queued.text)
    } catch {
      /* blocked or full storage */
    }
  }
}

/** Drop unreadable, empty and over-age entries, and those parked before
 *  drafts carried an account (`<prefix><canvasId>`, no `:`), then keep only
 *  the MAX_KEPT_DRAFTS most recently touched canvases. Runs inside the
 *  debounced write so it never costs a keystroke. */
export function pruneComposerDrafts(): void {
  prune()
}

/* `writing` is the key about to be stored: it is left out and keeps one of
   the MAX_KEPT_DRAFTS seats */
function prune(writing?: string): void {
  let entries: { key: string; at: number }[]
  try {
    entries = parkedKeys()
      .filter((key) => key !== writing)
      .map((key) => ({
        key,
        at: key.slice(KEY_PREFIX.length).includes(':') ? (readParked(localStorage.getItem(key))?.at ?? 0) : 0,
      }))
  } catch {
    return
  }
  const now = Date.now()
  const fresh = (entry: { at: number }) => entry.at > 0 && now - entry.at <= MAX_DRAFT_AGE_MS
  const keep = entries.filter(fresh).sort((a, b) => b.at - a.at)
  const seats = writing ? MAX_KEPT_DRAFTS - 1 : MAX_KEPT_DRAFTS
  for (const { key } of [...entries.filter((e) => !fresh(e)), ...keep.slice(seats)]) {
    try {
      localStorage.removeItem(key)
    } catch {
      /* a removal that fails only means the entry stays */
    }
  }
}
