# The `doop` CLI

Work with a redoop canvas from a project folder. The code lives in [`cli/`](../cli).

Inside this repo, `bun run doop <command>` runs `cli/bin/doop.ts`. For a `doop` command anywhere,
link the bin onto your PATH (`ln -s "$PWD/cli/bin/doop.ts" ~/.local/bin/doop`). Do not use
`bunx doop`: it fetches an unrelated npm package of the same name. The CLI talks to the MCP endpoint (`POST /mcp`, one stateless `tools/call`
per request), because agent keys authenticate MCP, not the cookie-based REST API.

```bash
# once, outside every repo: ~/.config/doop/config.json holds
#   {"url": "https://<your-doop-host>", "agentKey": "dpk_…"}   (key from Settings → Agent keys)
chmod 600 ~/.config/doop/config.json   # a key in a file others can read is refused

doop link <canvas-id-or-link>   # writes .doop.json in this folder
doop open [frame]               # the canvas (or one frame) in the browser
doop find "OTP"                 # find_in_canvas on the linked canvas; --all for every canvas
doop pull <frame> -o home.html  # the frame's HTML, its version recorded in .doop.json
doop push home.html             # shows +/- lines, asks, then set_frame_html
doop mcp install                # claude, codex, devin; or name some; --dry-run
doop config                     # where the URL and key come from (the key is never printed)
```

- The URL comes from `--url`, then `DOOP_URL`, then the `url` in `.doop.json`, then the config
  file. There is no default host. The key comes from `DOOP_AGENT_KEY`, then the config file
  (`$XDG_CONFIG_HOME/doop/config.json` when set).
- `push` refuses when the frame changed on the canvas since the pull (`--force` replaces it
  anyway). The design it replaces stays in the frame's version history, and an approval is
  withdrawn, as with any HTML edit. With no terminal to answer, it needs `--yes`.
- `mcp install` writes the `/mcp` URL only, as `claude mcp add`, `codex mcp add` and
  `devin mcp add` do: `~/.claude.json` (user scope), `~/.codex/config.toml` (`$CODEX_HOME`) and
  `~/.config/devin/mcp_config.json`. It shows each diff, asks, and backs the file up
  (`<file>.bak-doop-<time>`) before writing. Each client then signs in over OAuth on its own
  (`/mcp` in Claude Code, `codex mcp login doop`, `devin mcp login doop`). A Codex config with a
  different `doop` entry is refused, as in the desktop app's **Add to Codex**.
