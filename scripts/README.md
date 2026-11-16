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

## qa-model-picker.ts

Shoots the composer's model and effort pills for visual review, on the seeded demo
(`seed-demo.ts`: its own PGlite and a scripted model stand-in, so no provider is called):

```bash
npx tsx scripts/qa-model-picker.ts --out /tmp/visual-qa/model-picker --prefix after
```

- Connects a Claude Plan, Devin and Grok desktops and two keys, then shoots the foot, the model
  menu (closed, an Older fold open, a query typed from the list, no match), the effort popover and
  the duel slots (empty, filled, a repeated pick) in light and dark, plus a 300px Agents panel and
  pt-BR.
- Uses the demo's ports (4400, 4300); stop another demo first.

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
