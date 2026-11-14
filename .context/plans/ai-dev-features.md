# AI-dev features (ideas 2-16) - build plan

Source: `doop-for-ai-developers-ideas-2026-11-13.md` (Bryan's vault). Already built, out of scope: 1 handoff
to Stip, 5 live frames, 6 drift review, 8 library-first plan, 9 anti-slop lint. Status: proposed, waiting for
Bryan's go.

Rules for every feature: one `feat/*` branch, one commit per step, `bun run typecheck && bun run lint && bun run
test` before each commit, the README's "This fork" section updated, no push, no deploy.

## Order and dependencies

| #   | Feature (idea)                      | Branch               | Depends on              | Why here                                                                                             |
| --- | ----------------------------------- | -------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------- |
| 1   | Prompts and skills per canvas (11)  | `feat/canvas-skills` | -                       | Small. It extends the guidelines agents already load (`get_guidelines`). Upstream issue #380.        |
| 2   | Responsive + accessibility (14)     | `feat/frame-checks`  | -                       | It extends the lint badge and the Quality section, and uses the hardened renderer.                   |
| 3   | Usage per canvas and model (15)     | `feat/usage-meter`   | -                       | Foundation: an `agent_runs` ledger (tokens, cost, time, model). Nothing captures `usage` today.      |
| 4   | Agent run replay + rollback (16)    | `feat/run-replay`    | 3                       | Needs the run id on every `frame_versions` row that 3 adds. Rollback uses the existing versions.     |
| 5   | Model duel (10)                     | `feat/model-duel`    | 3                       | Same brief to 2-3 runner picks. It shows the cost and time from 3. The pick goes to `save_decision`. |
| 6   | Component ↔ file mapping (2)        | `feat/code-mapping`  | -                       | It reuses `repo_list` / `repo_search` to suggest the file. Read-only on the repo.                    |
| 7   | Two-way token sync (3)              | `feat/token-sync`    | 6 (shared diff surface) | Repo → doop through the read sandbox. Doop → repo as a proposed patch. It adds the desktop write.    |
| 8   | Frame → code export (4)             | `feat/frame-to-code` | 6, 7                    | It writes components mapped to the repo's files and tokens, through 7's approved-patch command.      |
| 9   | Auto import onto a "Built" page (7) | `feat/built-page`    | -                       | It reuses `/ingest` sync keys, `import_webpage` and the drift CI webhook.                            |
| 10  | `doop` CLI (12)                     | `feat/cli`           | 6 (canvas ↔ folder)     | Best once the APIs above are stable. It finds the canvas from a `.doop.json` in the repo.            |
| 11  | Pad link (13)                       | `feat/pad-link`      | -                       | Last: it needs Pad's API and authentication, which this repo does not know yet.                      |

Branches start from `bryann2k/main`. A dependent branch (4, 5 → 3; 8 → 7 → 6) starts from its parent's branch
until that one is merged.

## Steps per feature

1. **Canvas skills**: `skills` kind on guidelines (name, trigger, body) + REST/MCP `list_skills` / `get_skill` →
   resident and MCP agents load the matching skills on their own → Settings card and the Chat composer's "Use
   skill" menu.
2. **Frame checks**: render each frame at 375 / 768 / 1440 (overflow, clipped text, tap targets) → contrast and
   keyboard-focus audit (axe-style rules in the frame runtime) → Inspector summary + badge, MCP `check_frame`.
3. **Usage meter**: capture `usage` in every transport (Anthropic, OpenAI, Chat Completions, Claude CLI,
   Gemini) → `agent_runs` table + price table per model → canvas usage panel (per run, per model), MCP
   `get_usage`.
4. **Run replay**: `run_id` on `frame_versions` and the activity feed → per-run timeline with a before/after diff
   per frame → one-click rollback of a whole run (one undo step, refused on a frame edited since, unless
   confirmed).
5. **Model duel**: "Duel" in the composer launches the brief on 2-3 picks into sibling frames → comparison card
   (screenshot, cost, time, lint score) → the pick is kept as a canvas decision, the others archived.
6. **Code mapping**: `code_links` (component or frame → repo path + export name) → suggestions from
   `repo_search` → shown in the Inspector, in `get_component` / `get_frame` and in the handoff pack.
7. **Token sync**: parse CSS variables and the Tailwind theme from the linked repo into a token diff → apply
   in doop after approval → doop changes become a unified patch, written by a new desktop command
   `repo_apply_patch` (native dialog that lists the diff, sandboxed like `repo_write_change`).
8. **Frame → code**: HTML → Astro/React component with tokens and mapped components substituted → diff preview
   modal → write through `repo_apply_patch`, then update the mapping.
9. **Built page**: a preview-deploy webhook (per canvas, signed) → each listed route captured as a frame on a
   "Built" page, matched to its designed frame → designed vs shipped side by side, with a drift link.
10. **CLI**: `bunx doop` package (agent key auth) → `open`, `find`, `pull` / `push` of a frame as HTML →
    `doop mcp install` for Claude Code, Codex and Devin.
11. **Pad link**: needs Bryan's input first (Pad's API, auth, item ids). Then a frame / plan ↔ Pad item link,
    the status on the frame, the frame link in the item.

## Notes

- 7 and 8 need a **desktop release**: the new Rust write command, which the web build alone cannot provide.
- 3 touches every model transport. It is the riskiest step for regressions, so each transport gets its own
  test.
- `feat/find-insert` (⌘F insert) is finished and not merged yet. It is independent of everything above.
