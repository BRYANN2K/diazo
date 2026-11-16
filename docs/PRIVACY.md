# Diazo privacy

What a Diazo server and the desktop app store, what they send over the network, and to whom. Read by users, instance admins and reviewers. The facts come from the code (`server/`, `desktop/`) and `.env.example`.

Status: current, updated 2026-11-16

Diazo has no central service. Each instance belongs to whoever runs it, and its data stays on that machine or server. The Diazo project receives nothing from any instance.

## What a server stores

| Data                                                         | Where                                    | Notes                                                                      |
| ------------------------------------------------------------ | ---------------------------------------- | -------------------------------------------------------------------------- |
| Account: email, name, password hash, profile photo, sessions | database                                 | better-auth; sign-in with Google, Microsoft, Apple or OIDC stores the link |
| Canvases, pages, frames, versions, comments, activity        | database                                 | Frame versions are kept per frame; comments name their author              |
| Uploads (images, fonts, PDFs, rendered media)                | `data/assets` or an S3-compatible bucket | Readable by anyone who has the unguessable `/a/<id>` link                  |
| Model account keys and tokens, integration tokens            | database, sealed with AES-256-GCM        | Only the server's `SECRETS_ENCRYPTION_KEYS` can open them                  |
| Agent runs: model, tokens, time, cost, the versions written  | database (`agent_runs`)                  | Shown in the Usage tab                                                     |
| MCP OAuth tokens and agent keys                              | database                                 | Expired OAuth tokens are pruned daily                                      |
| Image descriptions                                           | database                                 | Only when the setting is on; see below                                     |

Settings → Your account → Delete account removes the account and the canvases only that person could reach.

## What a server sends, and when

| To                                                 | What                                                            | When                                                                    |
| -------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| The model provider of the runner picked            | the brief, frame HTML, screenshots, guidelines and tool results | each Diazo Agent run, curation or description, on that person's account |
| GitHub's public API, without a token               | a request for the newest image build of `BRYANN2K/diazo`        | at most hourly; `DOOP_UPDATE_CHECK=false` turns it off                  |
| The SMTP server configured                         | verification, password reset and comment emails                 | only when SMTP is set                                                   |
| Webhook URLs a person configured                   | signed event payloads (comments, frames, agent tasks)           | only for that person's webhooks                                         |
| Linear or Slack                                    | issues or messages                                              | only when someone connected the integration                             |
| Pexels, Brandfetch, DuckDuckGo favicons, icon CDNs | search terms                                                    | when an agent searches photos, logos or icons                           |
| Any URL a person or agent imports                  | an HTTP request from the server's renderer                      | website import, drift review, Built page capture                        |
| A remote browser service                           | pages to render, including frame HTML                           | only when `REMOTE_BROWSER_URL` is set                                   |
| PostHog                                            | product analytics and session replay                            | never by default: only when built with `VITE_POSTHOG_KEY`               |

The owner's instance is reachable on a tailnet only ([ADR 0004](adr/0004-expose-the-instance-over-tailscale-only.md)) and is built without an analytics key.

## Image descriptions

When the Agents setting is on, a model describes each uploaded image once, on the uploader's account, the canvas owner's, or the server's tier. The description is stored with the asset and given to agents that read the frame. Off, nothing is sent.

## The desktop app

- Stores the chosen server (`server.json`), the CLI link (`cli.json`) and its browser profile (cookies, local storage) in `~/Library/Application Support/dev.bryann2k.diazo` on macOS.
- Checks `https://github.com/BRYANN2K/diazo/releases/download/desktop-updates/latest.json` at launch and daily for updates.
- A linked project folder stays on the Mac. The app reads a file only when an agent asks, and sends that file's content to the server, which may pass it to the model of the run. Writes need a native confirmation that lists the diff.
- Local agents (Claude Code, Devin, Grok) run on the CLIs already signed in on the Mac. What they send follows their own provider's policy.
- Live frames and drift fetches reach `localhost` only.

## The local install

`~/.diazo` holds `diazo.env` (secrets generated on the Mac, mode 600) and `data/` (the database and uploads). Nothing leaves the Mac except the requests listed above.
