# Frontend redesign, part 1

## Intent

The web app and the desktop app look and move like the redesign frames, in light and dark, without breaking any existing screen or behaviour.

## Acceptance criteria

- AC-1: `src/styles.css` defines the role tokens of the redesign (ground, paper, surface, well, line, ink 1 to 3, signal, agent, ok, caution, danger, code) for light and dark, and every older token name resolves to a role.
- AC-2: The UI loads Atkinson Hyperlegible Next and Mono and Familjen Grotesk from `src/assets/fonts` with their OFL licence files, and makes no Google Fonts request for its own faces.
- AC-3: Motion tokens (durations, easings, springs, stagger) exist in CSS and in `src/lib/motion.ts`, and every animation stops or shortens under `prefers-reduced-motion`.
- AC-4: The primitives in `src/components/ui` match the "01 Foundations" components and each has a Storybook story.
- AC-5: The editor shell, chat and composer, Home and the Motion Studio panel match their redesign frames at the frame sizes.
- AC-6: Agent activity is shown in the agent colour with a mark or pattern as well, never by colour alone; people and selection use the signal colour.
- AC-7: `bun run typecheck`, `bun run lint`, `bun run format:check` and the full test suite, browser tests included, pass.
