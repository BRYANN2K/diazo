# Motion API — Motion Studio ("Rostrum")

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
}

type MotionClipSource =
  | { type: 'frame'; frameId: string }
  | { type: 'library'; itemId: string; variantId?: string }
  | { type: 'asset'; assetId: string }
  | { type: 'caption'; text: string; style?: string }
```

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
  | { op: 'update_clip'; trackId; clipId; start?; duration?; mediaStart?; gain?; muted?; name?; source? }
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
  format: 'mp4' | 'webm'
  target: 'browser' | 'desktop' // 'server','blender' reserved — rejected today
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

## Seek-safe markup contract

Adopted from HyperFrames (Apache-2.0). A scene is a frame document whose
root opts in; the runtime owns the clock, markup only describes timing:

| Attribute                                  | Where                              | Meaning                                                                 |
| ------------------------------------------ | ---------------------------------- | ----------------------------------------------------------------------- |
| `data-doop-scene`                          | scene root                         | this document is a scene                                                |
| `data-duration`                            | root                               | scene length, seconds                                                   |
| `data-fps` / `data-width` / `data-height`  | root                               | rate and raster                                                         |
| `data-start`                               | timed element                      | on-screen from t = start                                                |
| `data-duration`                            | timed element                      | visible `[start, start+duration)`                                       |
| `data-media-start`                         | media clip                         | trim into the source, seconds                                           |
| `data-track-index`                         | timed element                      | lane order in markup                                                    |
| `data-volume`                              | media                              | local volume 0..1                                                       |
| `data-hidden`                              | element                            | hidden below current scene index                                        |
| `data-doop-track` + `data-doop-track-kind` | lane                               | `graphics`/`captions`/`video`/`audio`/`3d`                              |
| `data-doop-motion`                         | `<script type="application/json">` | frame-authored keyframes `{ v:1, keyframes:[{el,prop,t,value,ease?}] }` |

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
  webm. → `200 { job, asset: { id, url } }`; stores `/a/<assetId>`,
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
| `lint_motion`        | `page_id, frame_id?`                                                               | `{ issues, summary }` — frame HTML (all frames on the page, or one) + composition checks                                                                                                        |
| `render_composition` | `page_id, format?, target?, range?`                                                | `{ job, note }` — queues a render job a browser/desktop client then claims                                                                                                                      |

`animate_storyboard` semantics: deterministic builder — shots follow the
frames' reading order (rows top→bottom, left→right inside a row), each shot
fits the camera to its frame (`margin` ≈ 1.08). Easing is `hold` (cuts);
the agent turns cuts into moves with `patch_composition` `set_camera` ops.

## Seek-safe lint — MO-* rules

`lintMotionHtml(html)` (static, per frame) + `lintComposition(comp)`:

| Rule  | Severity      | Fires on                                                                                                                      |
| ----- | ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| MO-01 | error         | `Date.now`, `new Date`, `performance.now` in a script — wall clock ≠ t                                                        |
| MO-02 | error         | `setInterval`/`setTimeout`/`requestAnimationFrame` in a script that doesn't listen for `doop:seek`                            |
| MO-03 | error         | `Math.random` without a seed marker — seed a local PRNG                                                                       |
| MO-04 | error         | CSS `animation`/`infinite` not bound to `var(--t)` via paused+delay                                                           |
| MO-05 | error         | GSAP (`gsap`, `TweenMax`, `<script src=…gsap>`)                                                                               |
| MO-06 | warning       | `fetch`/`XHR`/`WebSocket` in scene scripts — load once at setup                                                               |
| MO-07 | error         | `<video/audio autoplay>` — the runtime seeks media                                                                            |
| MO-08 | error         | timed media nested inside another `data-start` element                                                                        |
| MO-09 | warning       | `data-doop-scene` root without `data-duration`                                                                                |
| MO-10 | error         | a `data-doop-motion` block that doesn't parse                                                                                 |
| MO-11 | error/warning | composition checks: >1 camera track, dangling element/frame refs, out-of-range keyframes/clips, clips on the wrong track kind |

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

Blender groundwork: `__DOOP_BLENDER__` advertises the bridge; the shell can
spawn an allowlisted `blender-mcp` process (user-approved like ACP agents)
and relay read-only tools. Disabled by default (env `DOOP_BLENDER_BRIDGE`);
write/Python/render tools need an approval UX that does not exist yet.

## Changes

Contract changes after the first commit land here, dated.

<!-- append new entries below -->
