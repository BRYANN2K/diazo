# Make Connect work for the desktop ACP agents

Status: active, updated 2026-11-16

## Problem and authorized scope

In Settings → Diazo Agent → "Add an agent", Connect on "Devin (desktop)" or
"Grok (desktop)" did nothing. The five `acp_*` commands were registered in
the shell's `invoke_handler` but never declared in `build.rs` `commands()`
(which generates their `allow-*` permissions) nor granted in
`capabilities/default.json`, so the ACL refused every invoke. The page then
kept `native` null, and the row's panel, the only place the error showed,
never opened.

Scope: declare and grant the five commands, make the row always answer a
Connect press (a label while it waits, then the connected row or the error
under it), keep whichever half of a refresh answered, and a Rust test that
keeps every command declared and granted. Review follow-up: only Connect
says "Connecting…", and a failed background refresh clears once a later
one succeeds. No dependency, schema, release or publication work. Never
push or open a pull request.

## Decisions

Grant the commands in the existing `shell` capability, the same scope as
the `claude_*` commands: window `main`, the capability's remote URLs, plus
the chosen server at runtime (`server.rs` reuses this file). The hidden
webviews get none of them. The mount and focus refresh keep their failure
apart from a button's, so the focus a closing consent dialog hands back
cannot hide a Connect error.

## Approval source

The owner's bug report (Connect does nothing) and the review brief in
`/tmp/reviews/acp-connect.md`, whose required item is this change record
and whose nits the owner asked to take. This contract records that scope;
it adds no product decisions.
