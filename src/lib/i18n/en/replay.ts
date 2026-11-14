/** Run replay: one agent run's timeline, the before and after of every
 *  frame it touched, and the rollback of the whole run. */
export const replay = {
  title: 'Run by {agent}',
  lede: 'Everything this run did, oldest first, and each frame it touched as it was before and after.',
  loading: 'Loading the run…',
  failed: 'Could not load this run.',
  timeline: 'Timeline',
  noEvents: 'This run logged no activity.',
  frames: 'Frames',
  noFrames: 'This run changed no frame.',
  before: 'Before',
  after: 'After',
  createdByRun: 'Created by this run',
  deletedSince: 'Deleted since',
  editedSince: 'Edited since the run',
  openRun: 'Open the run',
  close: 'Close',
} as const
