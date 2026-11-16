# DESIGN - Diazo

Design tokens live in `src/styles.css` as CSS custom properties, mapped into Tailwind 4 via
`@theme`. shadcn is configured with style `radix-nova`, base color `neutral`, CSS variables on,
icon library `lucide` (`components.json`). Generate new shadcn components with the shadcn CLI
rather than hand-rolling primitives; it writes into `src/components/ui` per the aliases below.

## Source of truth

The UI follows the redesign frames on the canvas "redoop — Redesign 2026-11" (`bIK8evKpnI`): its
design tokens (`get_tokens`), the guidelines `redoop-system` and `redoop-build-notes`, the
components of 01 Foundations, and the pages "00 Brand — Diazo" and "18 Motion Studio". The direction
is the **Cyanotype bench**: a quiet graphite bench with one blueprint-blue signal for people and one
marker-orange for agents; type does the hierarchy; motion is physical, short and tied to a cause.

## Palette

Role tokens in `src/styles.css`, light then dark (`.dark`); Tailwind classes `bg-<role>`,
`text-<role>`.

- `--ground` `#eef0f2` / `#0c0d10` - the stage and the app backdrop (`bg-ground`; `--canvas` is
  its alias).
- `--paper` `#fbfbfc` / `#15171b` - a page. `--surface` `#ffffff` / `#1c1f24` - islands, cards,
  menus. `--well` `#f1f3f5` / `#22252b` - a filled field, a hovered or pressed row.
- `--line` `#e1e4e8` / `#2a2e35` - the 1px ring; `--line-soft` the quieter divider.
- `--ink` `#15171c` / `#eceef2`, `--ink-2` `#5b616b` / `#a3a9b3`, `--ink-3` `#9298a2` / `#6d737d` -
  text in descending emphasis; `--on-ink` is text on an ink fill. `--ink-ghost` - placeholders, unit
  letters.
- `--signal` `#1f5fff` / `#5b8cff` (+ `--signal-wash`) - **people and selection**: selection, focus,
  a person's presence, a checked menu row, an on chip.
- `--agent` `#e8650a` / `#ff8f45` (+ `--agent-ink`, `--agent-wash`) - **anything an agent does**:
  presence, cursor, the beam round a frame being written, thinking and streaming, agent badges.
  Never swapped with signal, and never shown by colour alone (mark + beam pattern).
- `--danger` (+ wash) - failure only, always icon + text. Delete is ink + confirm, not red.
  `--ok` (+ wash) - connected, passed, done. `--caution` / `--caution-ink` - hover or a selected
  frame only.
- `--code` / `--code-ink` - the dark code well of `CodeBlock` and the HTML editors, both themes.
- Aliases kept for older screens, all resolving to the roles: `--paper-deep` and `--sub` → well,
  `--ink-soft` → ink-2, `--ink-faint` → ink-3, `--brand` → signal, `--accent-ink` → danger,
  `--success*` → ok, `--warning*` → caution, `--glaze-ring` → agent. New code uses the role names.
- The primary button is ink with `--on-ink` text, one per screen.

## Typography

- Direction **B Hyperlegible**: `--font-ui` Atkinson Hyperlegible Next (the chrome), `--font-mono`
  Atkinson Hyperlegible Mono (values only: ids, sizes, numbers, key caps, code, costs),
  `--font-display` Familjen Grotesk (headings at 20px and up only; `--font-hero`, the home
  greeting, is the same face). Self-hosted variable woff2 (latin + latin-ext) in `src/assets/fonts`
  with their OFL licences; no Google Fonts request for the UI's own faces. Every stack lists
  `'Doop Keys'` after its face: a 5 KB cut of Inter carrying only the key symbols (⌘ ⌥ ⇧ ⌃ ⌫ ↩ ⇥ ⎋,
  arrows), inlined in `src/styles.css`. A new symbol in a hint goes into its `unicode-range` and the
  subset (rebuild steps in `src/styles.css`).
- Atkinson runs wide: the chrome is `text-body` 12.5px with `-0.005em` tracking (carried by the
  step), rows and menu items 30px, chips 26px, and labels never wrap (`whitespace-nowrap` +
  `truncate`). Numbers are `tabular-nums` everywhere (set on `body`).
- **The scale** is named by role, as `--text-*` tokens (each carries its line height and tracking,
  so one class sets all three). `text-[Npx]` is for a one-off the scale cannot name.

  | class          | size   | used for                                                    |
  | -------------- | ------ | ----------------------------------------------------------- |
  | `text-micro`   | 10.5px | key caps, mono captions                                     |
  | `text-caption` | 11px   | timestamps, counts, hints, badges, the line under a row     |
  | `text-label`   | 12px   | chrome labels, field labels, small buttons                  |
  | `text-body`    | 12.5px | the chrome's voice: rail rows, buttons, chips, menus, lists |
  | `text-copy`    | 13.5px | prose inside cards and dialogs, large buttons               |
  | `text-lead`    | 15px   | a dialog's lede, the composer's placeholder                 |
  | `text-heading` | 20px   | card and dialog headings (`font-display`)                   |
  | `text-title`   | 28px   | page titles (`DashTitle`, `font-display`)                   |
  | `text-display` | 44px   | the home greeting (`font-display`)                          |

- **Weights**: 400 for text, 500 for labels, buttons and emphasis, 600 for headings and badges.
- Icons: Lucide via `src/components/ui/icons.tsx`, stroke 1.5 (`ICON_STROKE`), 14 / 16 / 20px, and
  nowhere else. Tabs are icon + label; when a strip runs out of room (`useFitLevel`), the tabs not
  in view fold to their icon first (`PanelIconTab compact`), then the open one, each keeping its
  label as the accessible name and in a `Tooltip`. One glyph per destination: Community is `WebIcon`,
  Automations `WorkflowIcon`, Integrations `BlocksIcon`.

## Shape and depth

- Named corners: `rounded-tag` (4px, badges and checkbox squares), `rounded-control` (7px, buttons
  and fields), `rounded-row` (8px, list, menu and rail rows), `rounded-pill` (fully round, chips),
  `rounded-card` (12px, cards and tiles), `rounded-panel` (14px, floating islands), `rounded-sheet`
  (20px, dialogs). Reach for these before a `rounded-[Npx]`.
- Elevation, no borders on controls: 1 `shadow-ring` (a 1px `--line` ring, resting controls), 2
  `shadow-panel` (islands over the stage; `shadow-float` is its alias), 3 `shadow-pop` (menus,
  toasts), 4 `shadow-modal` (dialogs, over `--scrim`). Focus is a 2px signal outline offset 2px, or
  for a field a signal ring plus a 3px signal wash.
- The editor is a **floating shell** by default: islands on elevation 2, radius 14, a 12px gutter.
  Docked is an option (Settings → Appearance).

## Motion

Tokens in `src/styles.css` and mirrored for script in `src/lib/motion.ts` (`DURATION`, `EASE`,
`SPRING`, `staggerDelay`, `useReducedMotion`, `animate`); `tests/motion.test.ts` keeps the two in
step.

- Durations: `--dur-instant` 80ms (hover in), `--dur-fast` 140ms (hover out, press), `--dur-base`
  200ms (enters, tab glide), `--dur-slow` 280ms (panels, shared expand), `--dur-slower` 420ms (number
  roll). Tailwind: `duration-instant|fast|normal|slow|slower`.
- Curves: `ease-out` (enter), `ease-in-out` (between two states), `ease-exit` (leave), and three
  springs as CSS `linear()`: `ease-spring-soft` (400ms: dialogs, toasts, shared expand),
  `ease-spring-snap` (320ms: segmented pill, chips), `ease-spring-pop` (450ms: something landing).
- Enter: opacity 0→1, 6px up, .98→1 (`animate-enter`, keyframes `enter`). Exit at 70% of the time on
  `ease-exit`, no overshoot. Stagger 30ms over the first eight items (`stagger-children`). Hover is
  colour only, 80ms in / 140ms out. Press scales to .97 over 140ms (`press`).
- AI states are agent orange: the status label rolls through steps under a 2s shimmer
  (`shimmer-text`) and folds to "Thought for 12s"; streamed words fade in from a 4px blur
  (`word-in`); a 1px conic beam travels round a frame being written (`agent-beam`).
- Never animate zoom, pan, arrow nudges, undo/redo, typing or Tab selection.
- Reduced motion: transforms become 120ms opacity fades; the shimmer, beam and glaze hold still. A
  global rule in `src/styles.css` enforces it; script animation goes through `animate()`.

## Theme

- Light is the default; `.dark` on `<html>` switches every token above. The shadcn semantic set
  resolves through `--paper` / `--ink`, so `.dark` redefines only the primitives and shadows.
- The preference (`light` / `dark` / `system`) lives in `localStorage` under `doop-theme`, per
  browser. `index.html` paints it before the bundle loads; `src/lib/theme.ts` owns it after that
  (`initTheme()` in `main.tsx`, `useTheme()` in components). Controls: Settings -> Appearance and
  the account menu.
- `--ok`, `--caution`, `--danger` and their washes are the status colours; use them (`bg-ok-wash`,
  `text-ok`) rather than literal greens. Text on an ink fill is `text-on-ink`, never `text-white`,
  so it flips with the theme. `text-white` is for signal and agent fills and for dark overlays,
  which stay dark in both themes.

## Marks (Diazo)

The product is **Diazo** (a non-commercial fork of doop; doop's name and Disc-D logo are its
owner's trademarks and are not used). The brand sheet is the canvas page "00 Brand — Diazo"; the
source SVGs are in `.github/assets/diazo/`. Everything is drawn inline from
`src/components/Logo.tsx`, never from an image.

- **The mark ("02 Contact")**: an ink-outline D, the original, and offset bottom-right of it a
  solid signal-blue D, the print, which knocks a gap out of the outline where they overlap. One
  48-unit box. `Logo` is the colour mark (outline in the text colour, print in `--diazo-signal`:
  `#1f5fff`, `#5b8cff` in dark); `DiazoMark` is the inline glyph, one colour by default (`tone="color"`
  for the blue print, `color` for a pill). No tile, no container: the mark sits on the surface.
- **The wordmark**: "diazo", lowercase, Familjen Grotesk outlined into paths (no font loads), the
  i's dot a small blue print D. `DiazoWordmark` alone, `Wordmark` the mark + word lockup (headers,
  the auth card). It reads as "Diazo" to assistive tech; prose writes "Diazo" capitalised.
- **The reveal** (`DiazoMark animated`, the home greeting): the original draws its outline, then the
  print lands on it from the top left. Once, never looped; a plain fade under reduced motion.
- **The Diazo Agent** (the built-in agent; mention `@diazo`, `@doop` still routes): its own face,
  `DiazoAgentMark`, the two Ds smaller in agent orange (`--diazo-agent`: `#e8650a`, `#ff8f45` in
  dark) on a ringed surface disc. `working` animates it (an arc chases the ring, the original is
  redrawn, the print pulses), the presence pill's glaze state; at rest under reduced motion.
  `solid` is white Ds on a filled disc: `RoleMark` uses it in each role's crew colour. An outside
  agent never wears it: a known brand gets its `BrandMark`, an unknown MCP client the mono mark.
- **Colours** are the marks' only: `--brand` (`#0177d3`) stays the UI accent for selection and
  focus. The app icon (`desktop/app-icon.png`, from `app-icon-1024.svg`) is the colour mark on a
  pale gridded tile; favicons are `public/favicon.svg` (follows the OS theme) plus PNG/ICO
  fallbacks in the light colours.

## Component catalogue (Storybook)

- `bun run storybook` serves the catalogue on :6006; `bun run build-storybook` writes
  `storybook-static/`. Config in `.storybook/`, stories in `src/stories/` (CSF3, `*.stories.tsx`).
  It rides on the app's own `vite.config.ts`, so Tailwind, the `@` alias and the fonts need no second
  setup, and the toolbar's theme switch flips `.dark` the way `src/lib/theme.ts` does.
- Foundations (colours, the type scale, radii, shadows, every icon) render from the live tokens;
  Primitives cover `src/components/ui`; Marks is the one page every logo and avatar comes from
  (Diazo, its reveal, the Diazo Agent at rest and at work, the brands);
  Shell shows the rail and the search palette with sample data. A new primitive is not done until it
  has a story, and a new screen starts from this catalogue rather than from a blank file.

## Component index (`src/components/ui`)

Screens compose these; they do not draw their own buttons, fields, sizes, weights or colours (an
ESLint `no-restricted-syntax` rule in `eslint.config.js` holds `src/pages/**`, `src/components/**`
and `src/integrations/**` to it, banning raw elements and `role="button"` divs, arbitrary and
stock Tailwind type sizes and radii, `leading-[…]` / `tracking-[…]`, weights past `font-semibold`
and hex colours; only the not-yet-migrated editor chrome, listed in `LEGACY_CHROME`, is exempt).
Each has a story.

- `Button` - the ring button, one black `primary` per screen (`size="bar"` is the 32px header
  and toolbar action with a leading glyph: Import, New canvas; `size="inline"` is a boxless text
  action at the caption step, `bare` in a selection bar, `link` in a card or callout);
  `IconButton` - a glyph in a quiet square (sm 24px / md 32px / lg 34px, `round` for row actions,
  `on` keeps the paper-deep fill, `aria-label` required; `variant="primary"` is the ink send
  button, `frosted` the chip over a preview image, `danger` a row's remove ✕, and
  `frostedSurface` is that chip's surface for static marks beside it); `Pressable` - the
  chrome-less button a card tile, list row or inline text action is made of (focus ring only);
  `MenuButton` - a dropdown trigger with a trailing chevron (`ring` in a header, `quiet` inside a
  composer); `Chip` - the 32px suggestion pill with an 18px icon tile
  (`ChipIcon`), faded until hovered, focused or `on`; `ToggleChip` - the chosen-one-of-many pills
  (`ToggleChipItem size="sm"` for the compact shelf filters).
- `Input` / `Textarea` / `Field` / `Checkbox` / `Segmented` - form controls (`variant="well"`
  is the filled field of a modal or form: paper inside a hairline, no focus glow;
  `Textarea variant="code"` is the dark HTML editor); `Switch` - an on/off that applies at once
  (brand track, `size` sm 26x16 / md 34x20); `Select` - one value from a short list
  (`SelectTrigger` `size` sm 32px / md 36px, a ring control like `Input`; `value=""` shows the
  placeholder and no `SelectItem` may use the empty string, so a real "none" needs a sentinel);
  `SearchField` - the leading-glyph search
  (`ring` 30px pill, `bar` the palette's 48px top line; `size="header"` puts the ring on its own
  40px row on a phone and caps it at 320px from md) wrapping a bare Input, with a `trailing` slot
  for a `Kbd`; `Kbd` - a 20px key cap in mono micro type with an inset hairline.
  `StepSlider` - one pick from a short ordered scale (reasoning effort): the level named above a
  pill track filled to a round thumb, a dot per step, a native range input underneath.
- `Card` (`tone` default/flat/raised/dashed, `shape` hero for the 18px empty-state corner),
  `SettingsCard` - one section of a settings pane (Settings, Workspace): a `Card` at the 1000px
  settings width with the section spacing, any `tone`; `CardRow` - its labelled row, whose
  `control` slot holds the field at one width (`controlWidth` md 280px, lg 420px) so a card's
  fields line up, full width on phones; `EmptyState` (`card` hero on a list page, `dashed` with an `illustration` row on a table page:
  title, description, one `action`), `Tile` (the cover-and-meta grid tile on Home, Community and
  Admin: `tone` frosted/solid, `TileCover aspect="5/3|16/10|4/3"` the dotted well, `TileBody`,
  and `MetaLine`, which joins its parts with the quiet `·` and takes a separator-free `trailing`
  badge), `Callout`, `Note`, `Badge` (`tone` default/accent/outline/
  admin/banned, `brand` for the one highlighted option, `success` for a confirmed state; `shape`
  `pill` is the truncating source tag in a review header), `Dot`, `StatusLabel` (a `Dot` plus
  caption, `tone` done/muted: the "connected / not connected" line), `Progress`, `Skeleton` (`shape="tile"` takes the
  Tile's `aspect` and matches its footprint, `row` a 56px list row, `card` a 150px card),
  `CodeBlock`, `List` (`PersonRow` is one person on a line: `avatar`, `name`, `detail`,
  `trailing`), `ChoiceList` / `ChoiceRow` (a ringed panel of rows to go to, as Settings → Doop Agent lists its connections: `icon` an `AppIcon`, `title`, `description`, a chevron unless `trailing`; the import picker's sources, a frame's export formats), `SelectionBar` (`count`, `total`, `actions` of `SelectionBarAction`s: the "N of M
  selected · Clear" line over a checklist), `Steps` / `Step` (a numbered how-to, numbered by a CSS
  counter), `Tabs` (`TabsList variant="card"` is the phone's full-width pane
  switcher), `Dash*` (the dashboard frame; on a phone `DashHeader` draws the
  brand row itself, a rail toggle plus wordmark, whenever an `AppRail` is mounted, and the rail
  opens as a left drawer that closes on any pick) - surfaces and content. The rail is built from
  the same parts: `DashSidebar variant="rail"` (borderless, `bg-sub`, 236px), `DashSidebarBrand`
  (the Diazo mark as the home button, with the rail's own controls as children), `DashSectionLabel
density="rail"` (the group caption with its chevron) and `DashNavItem density="rail"` (the 31px
  row; `as="div"` for a static row such as an agent, `count` for a mono number, `trailing` for
  anything else). `DashHeader variant="bare"` drops the fill and the rule on the rail pages.
  Home, Automations, Integrations, Community, Workspace and Admin all mount `AppRail`, passing
  their own group as children; Settings draws its own rail from the same parts.
  `src/components/FramePreview.tsx` is the one frame-image-with-fallbacks (empty / failed, failure
  keyed per frame id) every thumbnail, card cover and gallery figure renders through. Its
  `src/components/library/ItemThumb.tsx` is a library item's image (its own thumbnail, else the
  frame preview cropped to the item's box, else `FramePreview`), and `LibraryTile.tsx` a library on
  the Libraries page (four item thumbnails as the `TileCover`, families · variants · role).
  `FrameThumb` is the boxed well a row or menu item leads with (`rounded-row`, `shadow-ring`,
  paper-deep fill): `size` xs 34x22 (table rows, menu items), sm 64x40 (list rows, the search
  palette, the export checklist), md 96px tall at its column's width (frame strips).
- `Modal`, `Sheet`, `AlertDialog`, `DropdownMenu`, `ContextMenu`, `Tooltip`, `Toast` - overlays.
  A dropdown is one menu everywhere: `DropdownMenuContent width="sm|md|lg"` (160 / 220 / 260px;
  unset is the 340px reading width) instead of a `w-[…]` or a re-skin, `DropdownMenuCaption` over a
  group, `DropdownMenuRadioGroup` / `DropdownMenuRadioItem` for pick-one rows (the check is drawn
  for you), and `description` on an item or radio item for the caption sub-line under its label.
  `Disclosure` (`collapsible.tsx`) - the fold-away aside in place of a `<details>`: a label with a
  turning chevron, the body kept mounted while folded.
- `AuthScreen` + `AuthCard` (`screen.tsx`) - every signed-out screen (sign-in, OAuth consent, the
  desktop hand-offs, a missing canvas): the wordmark and a `DashTitle` on one card, with
  `AuthCardText` for its prose and `align="center"` for a centred card. `InstallBlock` - an agent's
  one-click install in Connect AI (Codex, Claude Desktop, Cursor): `action`, a `status` line, an
  `error`, and the `manual` steps in a `Disclosure`.
- `Avatar` - the one presence face: a disc on a 2px surface collar, any px `size` (24 in the
  presence pill, 18 on a canvas card, 28-32 in menus and rows); a person is initials on a 22% tint
  of their colour, an agent its brand mark on the surface (the built-in Diazo Agent: its own ringed
  face filling the disc), `glaze` for an agent at work (the Diazo Agent animates instead), `stacked`
  to overlap, `children` replaces the initials. `PresenceFace` in `PeerAvatars.tsx` is the same
  component under the canvas chrome's name. `AvatarStack` (the first `max` people plus a "+N"
  disc), `tone="ink"` (the account's own face: initials on an ink disc, no collar), `initials()`
  (the one first-and-last-letter rule), `BrandMark` - every third-party logo (`<BrandMark brand="figma" size={16} />`; figma, github,
  canva, photoshop, meta, claude, openai, cursor, gemini, google, apple, microsoft, slack, linear, openrouter,
  deepseek, kimi, opencode);
  `AppIcon` is a model provider, import source or export format as doop.design's "Works with" row draws it:
  the brand tile (23% corners, inset edge and soft drop) with its glyph at 56% (`claude`, `claude-code`, `openai`,
  `gemini`, `openrouter`, `opencode`, `deepseek`, `kimi`, `seedream`, `codex`, `cursor`, `mcp`, `headless`, `github`, `figma`, `photoshop`, `canva`, `website`, `live-app`, `pdf`, `png`, `svg`,
  `jpg`), 32px in a list row and 40px beside a modal title,
  `Wordmark`, `Logo` / `DiazoMark` / `DiazoWordmark` / `DiazoAgentMark` (`src/components/Logo.tsx`,
  rules under Marks below), `icons.tsx` - identity. Feature tiles (`FigmaTile`, `MetaTile`, the
  integrations' `Tile`s, `AgentIcon`) compose a `BrandMark`; nothing else inlines a logo path.
- Editor chrome (`PropertyField`, `Toolbar`, `Panel`, `Menu`) - the canvas page's own set, still on
  exact pixel sizes until its pass. `Panel` has three surfaces: `floating` (an island over the
  board), `docked` (a flush column with a hairline on its canvas side, the Appearance setting's
  docked layout) and `inline` (filling a phone sheet).
- Sizing a primitive: a named step (`text-body`) where the box height is fixed or a `leading-*` sits
  beside it; a step with a leading modifier (`text-body/4`) where the box came from padding plus the
  browser's default leading, so putting it on the scale did not grow it.

## Aliases (`components.json`)

- `@/components` -> `src/components`, `@/components/ui` -> `src/components/ui`,
  `@/lib` -> `src/lib`, `@/hooks` -> `src/hooks`, `@/lib/utils` -> `src/lib/utils`.

## Breakpoints

- `--breakpoint-xs`: `30rem`, `--breakpoint-md`: `56.25rem` - custom additions on top of
  Tailwind's defaults.
