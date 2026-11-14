/** O medidor de uso: a aba Uso do painel de agentes, por execução e por
 *  modelo, com o custo do provedor ou da tabela de preços. */
export const usage = {
  tab: 'Uso',
  tabTitle: 'Uso — tokens, custo e tempo de cada execução de agente neste canvas',
  loading: 'Carregando o uso…',
  failed: 'Não foi possível carregar o uso.',
  empty:
    'Nenhuma execução de agente neste canvas ainda. Os tokens e o custo de cada execução aparecem aqui quando ela termina.',
  totalRuns: { one: '{count} execução', other: '{count} execuções' },
  totalCost: 'Custo total {cost}',
  totalTime: 'tempo de agente {time}',
  estimated: 'estimado pelos preços de tabela',
  unpriced: { one: '{count} execução sem preço', other: '{count} execuções sem preço' },
  byModel: 'Por modelo',
  runs: 'Execuções',
  runCount: { one: '{count} execução', other: '{count} execuções' },
  tokensInOut: '{input} entrada · {output} saída',
  cached: '{count} em cache',
  outcomeDone: 'Concluída',
  outcomeFailed: 'Falhou',
  outcomeStopped: 'Interrompida',
  kindChat: 'chat',
  refresh: 'Atualizar',
} as const
