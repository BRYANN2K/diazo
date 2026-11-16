# Motion API — Motion Studio ("Rostrum")

Status: current, updated 2026-11-16

A film is a page with a clock. This is the contract the timeline editor, the
player, the renderers and the agents code against. The types live in
`shared/motion.ts` (data + validation + ops), `shared/motionRuntime.ts`
(time → state) and `shared/motionLint.ts` (seek-safety rules). Additive
changes only — anything else lands in **Changes** at the bottom.

## Data model

### Composition

One per page. Attached to an _ordinary_ page — the page's frames are the
stage; deleting the page deletes its composition; copying the page copies it.

```ts
interface Composition {
  id: string // nanoid
  canvasId: string
  pageId: string
  duration: number // seconds, (0, 600]
  fps: number // integer, [1, 120]; presets 24/30/60
  width: number
  height: number // output raster px, [16, 8192]
  posterTime?: number // rest time for reduced-motion/static views, ≤ duration
  tracks: MotionTrack[] // display order, top lane first
  revision: number // bumps on every write — optimistic concurrency
  createdAt: number
  updatedAt: number
  updatedBy: string // last writer's name
}
```

### Tracks

```ts
type MotionTrackKind = 'camera' | 'element' | 'clip' | 'audio' | 'caption'

interface MotionTrack {
  id: string
  kind: MotionTrackKind
  name?: string
  muted?: boolean // audio: silenced; visual lanes: hidden in output
  frameId?: string // element tracks only
  elementId?: string // element tracks only — the target's data-doop-id
  keyframes?: MotionKeyframe[] // camera, element, and gain lanes on audio
  clips?: MotionClip[] // clip, audio, caption lanes
}
```

- `camera` — at most one. Keyframe properties are `x`, `y` (world coords of
  the view's centre), `zoom` (output px per world px) and `rotation`
  (degrees clockwise). The camera rect is `width×height` of the composition.
- `element` — animates one element inside one frame; `elementId` is the
  target's `data-doop-id`. Any property name or `--custom-prop` may be
  keyframed; the editor offers `ELEMENT_PROPERTIES` (x, y, scale, rotate,
  opacity, blur, color, …).
- `clip` — shots and media windows (`frame`, `library`, `asset` clips).
- `audio` — `asset` clips plus optional `gain` keyframes.
- `caption` — `caption` clips (text + a style preset name).

### Keyframes

```ts
interface MotionKeyframe {
  id: string
  property: string // camera prop / element prop / 'gain'
  t: number // seconds, [0, duration]
  value: number | string
  easing: MotionEasing // of the segment LEAVING this keyframe
}
```

```ts
type MotionEasing =
  | { type: 'linear' }
  | { type: 'hold' } // a cut: value stays until next key
  | { type: 'steps'; steps: number; position?: 'start' | 'end' }
  | { type: 'cubic-bezier'; x1; y1; x2; y2 } // x∈[0,1], y free
  | { type: 'spring'; stiffness; damping; mass } // physical, over real seconds
  | { type: 'token'; name: string } // a --ease-*/--spring-* token
```

`token` easings resolve against the canvas's motion tokens (CSS custom
properties `--ease-*`, `--spring-*`; `parseEasingToken` parses values like
`cubic-bezier(.2,.8,.2,1)` or `spring(180,26,1)`). Unresolved tokens fall
back to linear so output stays deterministic. `parseEasing` also accepts
the CSS names `linear`, `ease`, `ease-in`, `ease-out`, `ease-in-out`,
`step-start`, `step-end`, `hold` as string shorthand.

### Clips

```ts
interface MotionClip {
  id: string
  start: number
  duration: number // seconds; on screen [start, start+duration)
  source: MotionClipSource
  name?: string
  mediaStart?: number // trim into source media, seconds
  gain?: number // audio level, 1 = 0 dB
  muted?: boolean
  transition?: MotionTransition // how it takes over the previous clip
}

type MotionClipSource =
  | { type: 'frame'; frameId: string }
  | { type: 'library'; itemId: string; variantId?: string }
  | { type: 'asset'; assetId: string }
  | { type: 'caption'; text: string; style?: string }
  | { type: '3d'; assetId: string; fallbackAssetId?: string; driver?: 'time' | 'scroll' | 'pointer' }
```

A `3d` clip's `assetId` is a glTF/GLB canvas asset the frame's three.js
layer draws; `fallbackAssetId` is the still a non-3D surface (export,
thumbnail, an old shell) draws instead. `driver` defaults to `time` —
`scroll` or `pointer` scrubs the layer on page input even inside a timed
composition (the same driver names `data-doop-driver` uses in markup).

**Transitions** hang on the incoming clip — when a clip takes over from the
previous clip on the same track, `transition` says how. Absent = a hard cut.

```ts
interface MotionTransition {
  kind: 'dissolve' | 'push' | 'wipe' | 'zoom' | 'shared-element' // 'cut' is rejected: omit the field
  duration: number // seconds the two clips overlap
  token?: string // the --dur-* token the duration came from (retiming keeps the name)
  direction?: 'left' | 'right' | 'up' | 'down' // push/wipe travel
  easing?: MotionEasing // default per kind
}
```

Validation: `duration` must be `> 0` and may not exceed the clip's own
`duration` (a longer transition lints as a composition warning). A
transition on a non-clip track lints.

### Patch ops

`PATCH` and `patch_composition` apply a list of ops atomically:

```ts
type CompositionOp =
  | { op: 'set_meta'; duration?; fps?; width?; height?; posterTime? }
  | { op: 'add_track'; track }
  | { op: 'remove_track'; trackId }
  | { op: 'update_track'; trackId; name?; muted? }
  | { op: 'move_track'; trackId; index }
  | { op: 'set_camera'; t; x?; y?; zoom?; rotation?; easing? } // the "camera move"
  | { op: 'add_keyframe'; trackId; keyframe }
  | { op: 'update_keyframe'; trackId; keyframeId; t?; value?; easing? }
  | { op: 'remove_keyframe'; trackId; keyframeId }
  | { op: 'add_clip'; trackId; clip }
  | { op: 'update_clip'; trackId; clipId; start?; duration?; mediaStart?; gain?; muted?; name?; source?; transition? }
  | { op: 'remove_clip'; trackId; clipId }
```

`set_camera` upserts one keyframe per provided property at `t`, creating
the camera track if missing. Server mints ids for `set_camera` keyframes;
everywhere else the caller supplies ids (`/^[A-Za-z0-9_-]{1,100}$/`).

### RenderJob

```ts
interface RenderJob {
  id: string
  canvasId
  pageId
  compositionId: string
  format: 'mp4' | 'webm' | 'gif' | 'pngseq'
  target: 'browser' | 'desktop' | 'blender' | 'server'
  engine?: 'eevee' | 'cycles' | 'octane' // blender target only (default 'eevee')
  width
  height
  fps: number // defaults: the composition's
  range: { start: number; end: number } // seconds of composition time
  status: 'queued' | 'rendering' | 'encoding' | 'done' | 'failed' | 'canceled'
  progress: number // 0..1
  outputAssetId?: string // /a/<id> once done
  error?: string
  claimedBy?: string
  claimedAt?: number // the client/device doing the render
  createdBy: string
  createdByName: string
  createdAt
  updatedAt
  finishedAt?: number
}
```

Lifecycle: `POST …/renders` creates `queued` → the browser/desktop client
PATCHes `rendering` (claiming), PATCHes `progress` → PUTs the file to
`…/upload` → server stores the `/a/` asset and marks it `done`. `failed`
and `canceled` end it. Max `MAX_ACTIVE_JOBS` (3) non-finished jobs per canvas.

### Server renders (phase 5)

`target: 'server'` renders on the instance's own headless Chromium
(`server/motionRender.ts` through the renderer gate at background
priority), not on a client. The caps, enforced at creation:

- formats: `webm` and `pngseq` only — mp4/gif need ffmpeg, which stays on
  the desktop;
- range ≤ 60 s, raster ≤ 1080p, rate ≤ 30 fps;
- one open server render per account (429 otherwise).

One server render runs at a time on the whole instance; the page sits
behind the same public-network guard every other render uses and a
renderer lease sized to the job's budget, so a long render is not cut at
the renderer's default lease. The harness reads its canvas and
composition through a dedicated render token — `doop_render_token` /
`__Secure-doop_render_token` under HTTPS, httpOnly, bound to the job's
canvas and page, honoured only for the two GETs it needs, expiring with
the render budget and revoked when the render ends. Seeks are in
seconds; `pngseq` frames are appended to a zip on disk as they arrive
(size caps charged per frame), `webm` is encoded frame by frame through
WebCodecs at explicit timestamps and muxed server-side — nothing is
recorded in real time. The result lands as the job's `/a/` asset. The
whole target is off when the instance sets `SERVER_RENDER_DISABLED` (503
at creation).

## Seek-safe markup contract

Adopted from HyperFrames (Apache-2.0). A scene is a frame document whose
root opts in; the runtime owns the clock, markup only describes timing:

| Attribute                                  | Where                              | Meaning                                                                          |
| ------------------------------------------ | ---------------------------------- | -------------------------------------------------------------------------------- |
| `data-doop-scene`                          | scene root                         | this document is a scene                                                         |
| `data-duration`                            | root                               | scene length, seconds                                                            |
| `data-fps` / `data-width` / `data-height`  | root                               | rate and raster                                                                  |
| `data-start`                               | timed element                      | on-screen from t = start                                                         |
| `data-duration`                            | timed element                      | visible `[start, start+duration)`                                                |
| `data-media-start`                         | media clip                         | trim into the source, seconds                                                    |
| `data-track-index`                         | timed element                      | lane order in markup                                                             |
| `data-volume`                              | media                              | local volume 0..1                                                                |
| `data-hidden`                              | element                            | hidden below current scene index                                                 |
| `data-doop-track` + `data-doop-track-kind` | lane                               | `graphics`/`captions`/`video`/`audio`/`3d`                                       |
| `data-doop-motion`                         | `<script type="application/json">` | frame-authored keyframes `{ v:1, keyframes:[{el,prop,t,value,ease?}] }`          |
| `data-doop-split`                          | text element                       | unit split a text animator animates: one of `TEXT_SPLITS` (`char`/`word`/`line`) |

The motion block may also carry `animators: FrameTextAnimator[]` — text
animator specs `expandTextAnimator` (shared/motionText.ts) folds into
per-unit keyframes on generated unit targets (`el[i]` → selector
`[data-doop-id="el"] [data-doop-unit="i"]`):

```ts
interface FrameTextAnimator {
  el: string // element carrying data-doop-split
  split: 'char' | 'word' | 'line'
  preset: 'rise-blur' | 'typewriter' | 'scale-pop' | 'mask-wipe' | 'tracking-in' | 'scramble'
  start: number // first unit's time, seconds
  duration: number // per-unit length
  stagger: number // between unit starts
  order?: 'forward' | 'center' | 'random'
  ease?: MotionEasing
  seed?: number // 'random' order and 'scramble' are deterministic per seed
}
```

**Camera presets** (`shared/motionPresets.ts`) compile named moves —
`dolly-in`, `dolly-out`, `pan`, `orbit`, `handheld`, `whip-pan`, `crane`,
`establish` — to ordinary camera-track keyframes: `presetToKeyframes(preset, {start, duration, from, to, seed})`. `handheld` jitter and
`whip-pan` overshoot are seeded so a recompile reproduces them bit-exact.

**Element properties** (element tracks and frame keyframes) accept the
transform set (`x`, `y`, `scale`, `scaleX`, `scaleY`, `rotate`, `skewX`,
`skewY`), paints (`opacity`, `color`, `backgroundColor`, `borderRadius`),
filters (`blur`, `brightness`, `contrast`, `saturate`, `grayscale`,
`hue-rotate`), masks and paths (`clipPath`, `offsetPath`, `offsetDistance`,
`offsetRotate`, `d`, `strokeDashoffset`, `strokeDasharray`), plus any
`--custom-property`. Numbers lerp; `inset()` clip-paths of the same shape
lerp component-wise; other strings flip at the segment midpoint.

Runtime contract: the player writes `--t` on the scene root and dispatches
`doop:seek` at every seek. Scripts must derive pixels from `t` — never from
`Date.now`, timers, or free-running `requestAnimationFrame`. `lint_motion`
(the MO-* rules below) flags violations statically.

## REST routes

All under the canvas access gates: reads need `view`, mutations need `edit`.
Comment/view link holders cannot mutate. Payloads are validated
server-side (`shared/motion.ts` parsers); `expectedRevision` returns
`409` when the composition moved under the writer.

### Timeline

```
GET    /api/canvases/:id/pages/:pageId/composition
PUT    /api/canvases/:id/pages/:pageId/composition
PATCH  /api/canvases/:id/pages/:pageId/composition
DELETE /api/canvases/:id/pages/:pageId/composition
```

- `GET` → `200 { composition: Composition | null }`
- `PUT` (edit) creates or replaces the whole timeline.
  Body: `{ duration, fps, width, height, posterTime?, tracks?, expectedRevision? }`
  → `200 { composition }`. Errors: `400` invalid body, `404` no such page,
  `409` revision mismatch.
- `PATCH` (edit) applies ops atomically.
  Body: `{ ops: CompositionOp[], expectedRevision? }` → `200 { composition }`,
  `400` with `{ error }` when an op fails (nothing is applied).
- `DELETE` (edit) removes the page's timeline → `200 { ok: true }`.

Every successful write broadcasts `composition` to the room.

### Scene versions + code export

```
GET  /api/canvases/:id/pages/:pageId/composition/versions
POST /api/canvases/:id/pages/:pageId/composition/versions/:versionId/restore
GET  /api/canvases/:id/pages/:pageId/composition/export
```

- `GET …/versions` (view) → `{ versions: [{ id, savedAt, savedBy,
savedByKind, duration, trackCount, revision }] }`, newest first. Every
  write files the state it replaced (max 20, `MAX_COMPOSITION_VERSIONS`).
- `POST …/versions/:id/restore` (edit) → `200 { composition }` — replaces
  the live timeline with the version's state, keeping the composition id.
  The state it replaced is filed as a new version, so a restore is itself
  undoable. `404` when the version belongs to another composition.
- `GET …/export` (view) → `{ files: [{name, content}], tokens: string[],
notes: string[] }` — the "copy as code" export: `composition.css` with one
  `@keyframes` per animated element on the composition clock (transform
  and filter lanes composed per stop, token easings kept as `var(--*)`),
  `composition.js` with the same motion as WAAPI `Element.animate` calls,
  the camera as the world wrapper's transform, transitions as pairing
  notes, springs sampled to `linear()`. Frame-authored `data-doop-motion`
  keyframes and text animators are included (animators expand to unit
  targets `[data-doop-id="el"] [data-doop-unit="i"]`).

### Scene-time comments

`POST /api/canvases/:id/comments` accepts `timeStart` + `timeEnd` (seconds
on the page's composition clock, both required together, `0 ≤ start < end
≤ duration`) on a page comment — the thread a time range on the timeline
is about. They ride the comment's `timeStart`/`timeEnd` fields and the
`comments` table's `time_start`/`time_end` columns.

### Render jobs

```
GET    /api/canvases/:id/pages/:pageId/composition/renders
POST   /api/canvases/:id/pages/:pageId/composition/renders
GET    /api/renders/:id
PATCH  /api/renders/:id
PUT    /api/renders/:id/upload
DELETE /api/renders/:id
```

- `GET …/renders` (view) → `{ jobs: RenderJob[] }`, newest first.
- `POST …/renders` (edit) body `{ format, target, width?, height?, fps?,
range?: { start, end } }` → `201 { job }`. Defaults: composition's size/fps,
  full range. `429` when `MAX_ACTIVE_JOBS` are already open.
- `GET /api/renders/:id` (view on the job's canvas) → `{ job }`.
- `PATCH /api/renders/:id` (edit) — the renderer's heartbeat.
  Body `{ status?: 'rendering'|'encoding'|'failed'|'canceled', progress?,
error?, claimedBy? }` → `{ job }`. `rendering`/`encoding` claim the job
  (`claimedBy` = the client or device id). `done` is set by upload only.
- `PUT /api/renders/:id/upload` (edit) — raw video bytes,
  `Content-Type: video/mp4|video/webm` matching `job.format`, ≤ 250 MB
  (`MOTION_LIMITS.RENDER_MAX_BYTES`). Sniffed: `ftyp` for mp4, EBML for
  webm, `GIF8` for gif, `PK\x03\x04` for pngseq (a zip of stills — stored
  as `/a/<id>.zip`). → `200 { job, asset: { id, url } }`; stores `/a/<assetId>`,
  sets `done` + `outputAssetId`, broadcasts `render:progress`.
- `DELETE /api/renders/:id` (edit) → `{ job }` with `status: 'canceled'`.

## Room messages

`shared/types.ts` — broadcast to every client on the canvas room:

```ts
// server → clients
| { type:'composition'; pageId; composition: Composition | null; actor }   // null = removed
| { type:'composition:playhead'; clientId; pageId; t; playing: boolean }
| { type:'render:progress'; job: RenderJob }

// client → server
| { type:'composition:playhead'; pageId; t; playing?: boolean }            // needs 'view'
```

`composition` rides `init.canvas.compositions` like pages and guides.
`composition:playhead` is presence (follow-mode/playhead sync), not an edit.

## MCP tools

Canvas tools take `canvas_id`; resident-agent tools are scoped to the run's
canvas and take `page_id` only. All writes need the `edit` role.

| Tool                 | Input                                                                              | Result                                                                                                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_composition`    | `page_id`                                                                          | `{ composition }` or `{ composition: null }`                                                                                                                                                    |
| `set_composition`    | `page_id, duration, fps, width, height, poster_time?, tracks?, expected_revision?` | `{ composition }` — full create/replace                                                                                                                                                         |
| `patch_composition`  | `page_id, ops: CompositionOp[], expected_revision?`                                | `{ composition }` or `{ error }` on a failed op / `409`-style message on revision mismatch                                                                                                      |
| `animate_storyboard` | `page_id, brief?, shot_seconds?, margin?, replace?`                                | `{ composition, shots: [{frameId,t,duration}], note }` — builds camera-track shots from the page's frames in reading order; refuses to overwrite an existing composition unless `replace: true` |
| `lint_motion`        | `page_id, frame_id?, library_id?, item_id?`                                        | `{ issues, summary }` — frame HTML + composition checks; with `library_id` + `item_id`, seek-safety checks one library Motion item and stores the verdict `insert_clip` trusts                  |
| `insert_clip`        | `page_id, library_id, item_id, variant_id?, start, duration?`                      | `{ composition, clip, seekSafe }` — inserts a library Motion item as a clip; refuses a non-seek-safe item with the lint reasons                                                                 |
| `export_composition` | `page_id`                                                                          | `{ files, tokens, notes }` — the same CSS + WAAPI export as `GET …/export`                                                                                                                      |
| `render_composition` | `page_id, format?, target?, range?`                                                | `{ job, note }` — queues a render job a browser/desktop client then claims; `format` is `mp4`/`webm`/`gif`/`pngseq` (gif/pngseq: desktop only)                                                  |

`animate_storyboard` semantics: deterministic builder — shots follow the
frames' reading order (rows top→bottom, left→right inside a row), each shot
fits the camera to its frame (`margin` ≈ 1.08). Easing is `hold` (cuts);
the agent turns cuts into moves with `patch_composition` `set_camera` ops.

## Seek-safe lint — MO-* rules

`lintMotionHtml(html)` (static, per frame) + `lintComposition(comp)`:

| Rule  | Severity      | Fires on                                                                                                                                                                                |
| ----- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MO-01 | error         | `Date.now`, `new Date`, `performance.now` in a script — wall clock ≠ t                                                                                                                  |
| MO-02 | error         | `setInterval`/`setTimeout`/`requestAnimationFrame` in a script that doesn't listen for `doop:seek`                                                                                      |
| MO-03 | error         | `Math.random` without a seed marker — seed a local PRNG                                                                                                                                 |
| MO-04 | error         | CSS `animation`/`infinite` not bound to `var(--t)` via paused+delay                                                                                                                     |
| MO-05 | error         | GSAP (`gsap`, `TweenMax`, `<script src=…gsap>`)                                                                                                                                         |
| MO-06 | warning       | `fetch`/`XHR`/`WebSocket` in scene scripts — load once at setup                                                                                                                         |
| MO-07 | error         | `<video/audio autoplay>` — the runtime seeks media                                                                                                                                      |
| MO-08 | error         | timed media nested inside another `data-start` element                                                                                                                                  |
| MO-09 | warning       | `data-doop-scene` root without `data-duration`                                                                                                                                          |
| MO-10 | error         | a `data-doop-motion` block that doesn't parse                                                                                                                                           |
| MO-11 | error/warning | composition checks: >1 camera track, dangling element/frame refs, out-of-range keyframes/clips, clips on the wrong track kind, transitions longer than their clip or on non-clip tracks |
| MO-12 | warning       | a text animator's target element missing `data-doop-split`, or a split value outside `TEXT_SPLITS`                                                                                      |

## Runtime — `shared/motionRuntime.ts`

```ts
frameStateAt(comp: Composition, t: number, opts?: {
  resolveEasing?: (name: string) => MotionEasing | undefined
  frameBlocks?: ReadonlyMap<string, FrameMotionKeyframe[]>   // data-doop-motion per frame
}): CompositionStateAt

interface CompositionStateAt {
  t: number                                             // clamped to [0, duration]
  camera: { x; y; zoom; rotation } | null               // null = no camera keyframes
  elements: Record<string, Record<string, number|string>>  // 'frameId/elementId' → props
  activeClips: { trackId; kind; clip }[]
}
```

Rules: `t` clamps into `[0, duration]`; a lane holds its endpoint values
outside its keyframes; numbers lerp, same-shape colors lerp per channel,
other strings flip at the segment midpoint (`hold` never flips); element
tracks override frame-block properties of the same name; muted tracks are
skipped. `frameStateAt` is pure — the player seeks by calling it, never by
advancing DOM clocks.

## Desktop bridge (Tauri)

Behind `window.__DOOP_MOTION_RENDER__` (capability `motion-render`):

- `invoke('motion_render', { jobId, url, format, fps, frames, width, height })`
  opens a hidden webview on `url` (must be the app's own origin or
  loopback). The page's render harness implements
  `window.__doopMotionSeek(t)` + `__doopMotionCapture() → png data URL`;
  Rust drives the loop deterministically, writes frames, encodes with an
  allowlisted `ffmpeg` found via the login-shell PATH and fixed system
  paths — never a page-supplied path or args — into `<appData>/renders/`.
  Emits `motion-render://progress` `{ jobId, phase: 'capture'|'encode',
done, total }` events; returns `{ path, bytes }`.
- `invoke('motion_read_render', { path })` → base64 bytes — path must be
  inside `<appData>/renders/`; the page then PUTs it to `/api/renders/:id/upload`.

Blender bridge: `__DOOP_BLENDER__` advertises it; the shell spawns an
allowlisted `blender-mcp` process (env `DOOP_BLENDER_BRIDGE`, ADR 0011).
Read tools relay once started; `write` and `render` classes each need a
grant recorded through `blender_approve`, which confirms natively in the
desktop shell and is kept per connected server origin in
`blender-approvals.json` (withdrawn by `blender_revoke`). Tool arguments
follow the shared strict schemas in `shared/blender.ts`, re-validated in
the shell; a render's output path is not caller-controlled — renders land
under `<appData>/blender-renders/`. Python execution is never
allowlisted.

## Changes

Contract changes after the first commit land here, dated.

<!-- append new entries below -->

- **2026-11 — server renders and review hardening.** Server render jobs run
  one at a time behind the public-network guard with a budget-sized lease,
  authenticate with a render-scoped token (no minted session), seek in
  seconds, stream `pngseq` frames to a zip on disk and encode `webm` frame
  by frame through WebCodecs muxed server-side. `generate_video` downloads
  through the SSRF-pinned fetch under a 512 MB cap and stores only
  sniffed mp4/webm; `first_frame`, `last_frame` and references are bounded
  and the requester's own provider account is required. Blender grants
  confirm natively per server origin, arguments follow shared strict
  schemas and render paths are shell-owned. Speech model installs
  validate the HF repo on every path, allowlist the bundled catalog and
  confirm natively for anything else; `speech_stage_input` /
  `speech_read_output` carry job audio in and results out. Migrations
  renumbered 0074–0080 after the Orca branch.

- **2025-02 — additive helpers + render defaults.** `shared/motion.ts` gains
  `elementKey(frameId, elementId)` (the `frameId/elementId` index key used by
  `FrameState.elements`) and `remapCompositionRefs(comp, frameIds)` which the
  server applies when a page or canvas is duplicated: element-track `frameId`s
  and `frame` clip sources are rewritten through the copy's id map, refs to
  frames outside the copy are left alone. On `POST …/composition/renders`
  `target` is now optional and defaults to `'browser'`; `format` stays
  required.
- **2026-02 — phase 2.** Clips carry `transition` (`update_clip` accepts
  it, `null` clears); the motion block may carry `animators`
  (`data-doop-split` + presets, MO-12 lints them); camera presets in
  `shared/motionPresets.ts`; mask/path element properties. Render jobs
  accept `gif`/`pngseq` — uploads sniff `GIF8`/`PK`, the desktop encodes
  GIF via ffmpeg's two-pass palette and zips stills dependency-free.
  `GET …/composition/versions` + `POST …/versions/:id/restore` expose the
  undo history; `GET …/composition/export` + `export_composition` compile
  CSS/WAAPI with token names kept. `insert_clip` inserts a library Motion
  item after its stored seek-safe verdict (`lint_motion` with
  `library_id`+`item_id` computes/stores it on `library_item_meta`).
  Page comments accept `timeStart`/`timeEnd` — scene-time threads.
- **2026-02 — phase 3 (media).** Clips carry `speed` (0.25–4, one value per
  clip), `fadeIn`/`fadeOut` and caption sources carry per-word `words`.
  `scene_media` is the per-page state of a media asset: `trimIn`/`trimOut`,
  `cuts` (source-time ranges playback and export skip — transcript edits are
  data), `beats` (`{markers, bpm}`), `transcript` (`{language, words[],
speakers{S1:name}, engine, model, target, provider, jobId}`) and
  `generation` (`{provider, model, prompt, seed, refs, voice, text, style,
cost}`). Routes: `GET …/pages/:pageId/media`,
  `PUT …/pages/:pageId/media/:assetId`, `DELETE …/pages/:pageId/media/:mediaId`.
  Tools (MCP + resident): `list_media`, `set_media`, `build_captions`
  (transcript → word-timed caption clips on the caption track, cut words
  dropped, times shifted onto the clip's window), `duck_audio` (voice ranges
  → editable gain keyframes on an audio track; a media_id's transcript marks
  the speech), `suggest_cuts` (fillers + silences as cut candidates).
  `list_video_models`/`generate_video` run the person's own OpenRouter or
  Gemini key (registry in `shared/videoModels.ts`, dated per-second prices,
  estimate shown first): the file lands as an /a/ asset, `scene_media`
  keeps `{provider, model, prompt, seed, cost}` and a clip is placed on the
  clip track.

## Phase 3 speech jobs

The additive speech job contract is in [speech-api.md](speech-api.md), with
shared types in `shared/speech.ts`. REST, MCP and resident tools share the
same submission, estimate, ownership and completion logic. Desktop relay
and persisted transcripts are implemented; the installer, local engine
worker and speech sidecar remain pending. This does not complete phase 3.

## Phase 4 — 3D and the Blender bridge

**3D layers.** A `3d` clip source (above) points at a glTF/GLB canvas asset;
the frame renders it with a three.js layer and any surface without WebGL
draws `fallbackAssetId`. `driver` reuses `DRIVERS` (`time`/`scroll`/`pointer`)
so the same keyframe data can scrub on page input — `data-doop-driver` in
markup already carries the same names.

**Blender ops.** An agent never reaches Blender: it queues an op, the
desktop shell claims it through the poll, runs the allowlisted blender-mcp
tool and finishes it (`shared/blender.ts`).

- `POST /api/blender/ops` `{ canvasId, tool, args }` → `{ op }` (edit access;
  tool ∈ `get_scene_info`, `get_object_info`, `set_material`, `add_light`,
  `render_frame`; `klass` marks the approval class). ≤ 8 open ops per
  requester; args ≤ 64 kB of JSON.
- `POST /api/blender/poll` `{ deviceId }` → `{ ops }`: claims this person's
  queued ops, oldest first.
- `POST /api/blender/finish/:id` `{ deviceId, state: 'done'|'failed',
result?|error? }` — only the claiming device, while `running`.
- `GET /api/blender/ops[/:id|?canvasId=]` — the requester's own ops.
  A claim without a heartbeat fails after 10 minutes; boot recovery fails
  ops left `running`.

**Agent tools** (MCP + resident, same runner `server/blenderTools.ts`):
`blender_get_scene`, `blender_get_object` (read), `blender_set_material`,
`blender_add_light` (write approval in the shell), `blender_render_frame`
(render approval; `engine` ∈ `eevee`/`cycles`/`octane` — Octane is a name
Blender interprets, not an integration), and `get_blender_result { op_id }`
to poll.

**Blender render target.** `POST …/renders` accepts `target: 'blender'`
with optional `engine` (default `eevee`, validated against
`BLENDER_ENGINES`); the desktop claims it through the same render-job
lifecycle and renders frames through the bridge's `render_frame` tool —
which still needs the render grant.

## Interchange (phase 5)

`shared/motionInterchange.ts` converts a composition to and from Lottie
and HyperFrames documents. Both directions cover the same **vector
subset**: transform keyframes on element tracks — `x`/`y` → position,
`scale`/`scaleX`/`scaleY` → scale, `rotate` → rotation, `opacity` →
opacity. Anything a Lottie file carries beyond that (shapes, masks,
mattes, expressions) is skipped on import, never invented.

- `GET …/composition/export?format=lottie|hyperframes` → the document
  (JSON). `format` absent or `code` keeps the existing code export.
- `POST …/composition/import` `{ format, data, duration?, fps?, width?,
height? }` → replaces the page's composition with the converted tracks,
  validated by the same `parseCompositionBody` a PUT takes. `400` on a
  malformed document or an out-of-subset body.

Lottie specifics: `fr`/`w`/`h` from the composition, one transform-only
null layer per element track named `frameId/elementId` (the name rides
back on import so a round trip rebinds the same element; foreign files
land on `lottie-<ind>`). Times are frames, scale and opacity percent.

HyperFrames specifics: `{ format: 'hyperframes-project', version: 1,
scene: { fps, width, height, duration, layers } }` — each layer keeps the
track's id, kind, name and keyframes (`{ t, prop, v, ease }` with easing
names) plus its clips verbatim.

## The motion duel

`POST /api/canvases/:id/motion-duels` `{ pageId, brief, picks }` starts a
duel where the entries are **copies of one storyboard page**, not empty
frames: the page is duplicated once per pick (`store.duplicatePage` —
frames, guides and composition remap to the copy), and each pick gets a
queued card scoped to the first frame of its own copy, telling it to
animate that page with the motion tools and queue a render for
comparison. One resident task is metered per entry, like a model duel.

The row is a normal `model_duels` row with `kind: 'motion'` and
`pageId` on each entry — `GET /api/canvases/:id/duels` lists it with the
others. `POST …/duels/:duelId/pick` works as for model duels (the picked
entry's `frameId` is its anchor frame); on a motion duel the losing
**pages** are archived — every frame they hold is hidden and renamed —
while the winner's page stays as the take to keep.
