# scripts

Repo maintenance and one-off tools. Each file's header comment is its full documentation.

## pull-library.ts

Copies a canvas (a design library, typically) from one Doop instance to another, through each
instance's `/mcp` endpoint with an agent key:

```bash
DOOP_FROM_KEY=dpk_… DOOP_TO_KEY=dpk_… npx tsx scripts/pull-library.ts \
  --from <source origin> --canvas <canvas id> --to <target origin> [--dry-run]
```

- The keys come from the environment only and are never written.
- The source is only read: `get_canvas` and `get_frame`, plus GETs of its public `/a/` assets.
- The target gets a new canvas with the same pages, frames (names, positions, sizes, HTML), and
  every `/a/` asset re-uploaded with `upload_asset`, the frame HTML pointing at the new URLs.
- Resumable: progress is kept in `doop-pull-library-<hash>.json` in the OS temp directory, so a
  rerun creates nothing already created. Delete that file to start over.
- A canvas holds 100 pages: for a bigger library, turn the target canvas into a library when the
  script stops, then rerun.
- Tests: `tests/pullLibrary.test.ts` (two servers; asserts the source received only reads).
