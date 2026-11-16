# Security policy

How to report a vulnerability in Diazo, which versions get fixes, and what a self-hoster should know. Read by reporters, instance admins and contributors.
Status: current, updated 2026-11-16

## Report a vulnerability

- Use GitHub private vulnerability reporting: open the Security tab of `BRYANN2K/diazo` and choose "Report a vulnerability".
- Do not open a public issue for a vulnerability.
- Include the commit or image you run (Settings → General → About shows it), the steps to reproduce and the impact.
- Diazo is a volunteer project. You get an answer when the maintainer can read it; there is no response time guarantee. Give a reasonable window for a fix before you disclose.
- A problem that is also in doop's code is reported to doop as well, through its own policy.

## Supported versions

Only the latest `main` (the `:main` image, the newest desktop release) gets fixes. The update check in Settings tells an admin when the instance is behind.

## Notes for self-hosters

- Set `BETTER_AUTH_SECRET` and `SECRETS_ENCRYPTION_KEYS`, and serve the instance over TLS. Without `SECRETS_ENCRYPTION_KEYS` in production, stored credentials are kept in plaintext and the server warns.
- Without SMTP, sign-up needs no email verification. Turn off email sign-up in Admin → Sign-in when the instance is not meant to be open.
- Canvases are private by default; sharing is by invite or an explicit per-canvas link.
- `/i/<frameId>.png` frame images and `/a/<assetId>` uploads are public to anyone who has the unguessable id: they power previews and cross-origin embeds.
- The owner instance is reachable over Tailscale only ([ADR 0004](docs/adr/0004-expose-the-instance-over-tailscale-only.md)). Keep yours behind a private network or an authenticating proxy if you do not want it public.
- What the server and the desktop app store and send is in [docs/PRIVACY.md](docs/PRIVACY.md).
