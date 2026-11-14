/** The frame checks (responsive + accessibility): the badge on the frame's
 *  name and their block in the Inspector's Quality section. */
export const checks = {
  badgeLabel: 'A11y',
  badgeTitle: 'Frame checks at 375 / 768 / 1440',
  clean: 'No frame-check issues',
  issueCount: { one: '{count} frame-check issue', other: '{count} frame-check issues' },
  scoreLabel: 'score {score}/100',
  heading: 'Responsive and accessibility',
  notChecked: 'Not checked yet: the checks run in the renderer after each design change.',
  noIssues: 'No issues at 375, 768 or 1440px, and the keyboard walk passes.',
  widthRow: '{width}px',
  widthIssues: { one: '{count} issue', other: '{count} issues' },
  widthOverflow: 'scrolls {px}px sideways',
  widthClean: 'clean',
  focusSummary: 'Keyboard: {reached}/{focusables} reached, {hidden} without visible focus',
  focusUnavailable: 'Keyboard walk did not run',
  run: 'Run checks',
  running: 'Checking…',
  runFailed: 'The checks could not run (no renderer on this server?)',
  stale: 'The design changed since this result',
  allWidths: 'all widths',
  keyboard: 'keyboard',
} as const
