/** Model duel: one brief to 2-3 models into sibling frames, the comparison
 *  card, and the pick kept as a canvas decision. */
export const duel = {
  open: 'Duel',
  openTitle: 'Send this brief to 2-3 models at once and compare',
  title: 'Model duel',
  lede: 'Pick {min} to {max} models. Each designs the same brief in its own frame, side by side.',
  briefPlaceholder: 'What should each model design?',
  noModels: 'Connect a model account in Settings to run a duel.',
  start: { one: 'Start with {count} model', other: 'Start with {count} models' },
  starting: 'Starting…',
  started: { one: 'Duel started with {count} model', other: 'Duel started with {count} models' },
  failed: 'Could not start the duel.',
  cancel: 'Cancel',
  cardsTitle: 'Model duels',
  lint: 'lint {score}',
  statusQueued: 'Queued',
  statusRunning: 'Designing…',
  statusFailed: 'Failed',
  keep: 'Keep this one',
  kept: 'Kept {label}: saved to Memory, the other entries archived',
  pickFailed: 'Could not keep this entry.',
} as const
