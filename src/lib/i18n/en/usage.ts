/** The usage meter: the Usage tab of the agents panel, per run and per
 *  model, with cost from the provider or the price table. */
export const usage = {
  tab: 'Usage',
  tabTitle: 'Usage — tokens, cost and time of every agent run on this canvas',
  loading: 'Loading usage…',
  failed: 'Could not load usage.',
  empty: 'No agent runs on this canvas yet. Each run’s tokens and cost show here once it ends.',
  totalRuns: { one: '{count} run', other: '{count} runs' },
  totalCost: 'Total cost {cost}',
  totalTime: 'agent time {time}',
  estimated: 'estimated from list prices',
  unpriced: { one: '{count} run without a price', other: '{count} runs without a price' },
  byModel: 'Per model',
  runs: 'Runs',
  runCount: { one: '{count} run', other: '{count} runs' },
  tokensInOut: '{input} in · {output} out',
  cached: '{count} cached',
  outcomeDone: 'Done',
  outcomeFailed: 'Failed',
  outcomeStopped: 'Stopped',
  kindChat: 'chat',
  refresh: 'Refresh',
} as const
