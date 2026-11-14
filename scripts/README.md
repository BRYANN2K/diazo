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

## library-thumb.ts

Renders a library item's thumbnail from a frame's HTML file the way the server does, next to the
old box-plus-margin clip, to check what a gallery tile will show:

```bash
npx tsx scripts/library-thumb.ts frame.html --id mo.bencho-particles --width 760 --height 560 \
  [--box x,y,w,h] [--out dir] [--wait interactive]
```

- Writes `<name>.after.jpg` (today's thumbnail) and `<name>.before.jpg` (the old clip).
- Without `--box` the item is the whole frame, as a family's box is.
- Needs a local Chrome (`CHROME_PATH` when it is not found).
