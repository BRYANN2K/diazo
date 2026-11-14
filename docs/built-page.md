# Built page: preview deploys beside their designs

A preview deploy tells doop which routes it shipped. doop captures each route
onto the canvas's **Built** page, next to a snapshot of the frame it was
designed as, and records the pair as a drift comparison. Re-deliver after the
next push and the same frames are rewritten in place.

## Setup

1. On the canvas, open **Import → Preview deploys** and click **Create deploy hook**.
2. Copy the endpoint and the signing secret. The secret is shown once; store it
   as a CI secret (`DOOP_BUILT_SECRET`). **Rotate secret** issues a new one and
   the old one stops working at once.
3. Optional: map routes to frames, one per line (`/pricing Pricing page`).
   Routes you leave out are matched by frame name.

Only the canvas owner, invited members and workspace members can manage the
hook. Deliveries write as the person who created it, and stop the moment that
person can no longer edit the canvas.

## Delivery

```http
POST /api/canvases/<canvas id>/built HTTP/1.1
Content-Type: application/json
X-Doop-Timestamp: 1791216000000
X-Doop-Signature: sha256=5d41402abc4b2a76b9719d911017c592…
```

```json
{
  "deployUrl": "https://my-app-git-feat-pricing.vercel.app",
  "routes": ["/", "/pricing", { "path": "/login", "frame": "Sign in" }],
  "commit": "a1b2c3d",
  "branch": "feat/pricing"
}
```

| Field       | Required | Meaning                                                                                 |
| ----------- | -------- | --------------------------------------------------------------------------------------- |
| `deployUrl` | yes      | The preview's base URL. http(s) only, no credentials, never a local or private address. |
| `routes`    | yes      | 1 to 20 rooted paths. A route is a string, or `{ "path", "frame" }` naming its frame.   |
| `commit`    | no       | Shown in the delivery report.                                                           |
| `branch`    | no       | Shown in the delivery report.                                                           |

A route is appended to the deploy's own path: `deployUrl` `https://x.dev/app/`
with route `/pricing` captures `https://x.dev/app/pricing`. Duplicates and
trailing slashes collapse (`/pricing/` is `/pricing`).

The signature is the one doop's outbound webhooks use (see
[webhooks.md](webhooks.md)): HMAC-SHA256 over `<X-Doop-Timestamp>.<raw body>`
with the hook's secret, hex, prefixed `sha256=`. The timestamp is in
milliseconds and must be within 5 minutes of the server's clock.

### Answers

| Status | When                                                                      |
| ------ | ------------------------------------------------------------------------- |
| `202`  | Accepted. The body is `{ "delivery": { "id", "status": "running", … } }`. |
| `400`  | Not JSON, or a field is invalid (the `error` says which).                 |
| `401`  | Missing, stale or wrong signature.                                        |
| `403`  | The hook's creator can no longer edit the canvas.                         |
| `404`  | The canvas has no deploy hook (never created, or deleted).                |
| `422`  | `deployUrl` is a local address. Use the in-app drift compare for those.   |
| `429`  | More than 6 deliveries in a minute on this canvas.                        |

Captures run in the background, one route after the other, and one delivery
per canvas at a time. The report lands on the hook: **Import → Preview
deploys → Last delivery** lists each route, the frame it matched, its drift
score and an **Open compare** link. A failing route is reported and skipped;
the others still land.

## What lands on the canvas

- A page named **Built**, created on the first delivery (an existing page with
  that name is reused).
- One row per route: `Designed — <frame name>` on the left, a snapshot of the
  design at delivery time; `Built — <route>` on the right, the shipped page
  captured at the designed frame's width (1440 px when no frame matches).
- A drift comparison per matched route, with `source: "webhook"`. It shows in
  the frame's **Compare with URL** history, and its link opens the compare:
  `/c/<canvas>?frame=<designed frame>&drift=<comparison>`.

Re-delivering a route rewrites its two frames in place: they keep the spot
you moved them to. A frame you deleted comes back on the next delivery.

### Matching a route to its designed frame

1. The route's own `frame` (a frame id or name) in the delivery.
2. The hook's stored mapping for that route.
3. A frame whose name reads like the route: `/` matches Home, Index or Landing;
   `/pricing` matches "Pricing" or "Pricing page"; `/docs/getting-started`
   matches "Docs getting started" or "Getting started".

Frames on the Built page and the hook's own captures never match.

## Addresses

The server opens the URL, so the drift review's rules apply: http(s) only, no
credentials in the URL, and the address must resolve to a public IP. A name that
resolves to a private address is refused per route, and redirects are checked
again where they land. Local URLs (`localhost`, `*.local`, RFC 1918) are
refused up front: a deploy pipeline has no doop desktop app to fetch them.

## CI recipe (GitHub Actions)

```yaml
- name: Send the preview to doop
  env:
    DOOP_URL: https://doop.example.com/api/canvases/k3Yx9/built
    DOOP_BUILT_SECRET: ${{ secrets.DOOP_BUILT_SECRET }}
    PREVIEW_URL: ${{ steps.deploy.outputs.url }}
  run: |
    body=$(jq -nc --arg url "$PREVIEW_URL" --arg sha "$GITHUB_SHA" \
      '{deployUrl: $url, routes: ["/", "/pricing"], commit: $sha}')
    ts=$(($(date +%s) * 1000))
    sig=$(printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$DOOP_BUILT_SECRET" -hex | sed 's/^.* //')
    curl -fsS -X POST "$DOOP_URL" \
      -H 'Content-Type: application/json' \
      -H "X-Doop-Timestamp: $ts" \
      -H "X-Doop-Signature: sha256=$sig" \
      --data "$body"
```
