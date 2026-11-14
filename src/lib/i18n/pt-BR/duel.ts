/** Duelo de modelos: um briefing para 2-3 modelos em frames lado a lado, o
 *  cartão de comparação, e a escolha guardada como decisão do canvas. */
export const duel = {
  open: 'Duelo',
  openTitle: 'Enviar este briefing para 2-3 modelos de uma vez e comparar',
  title: 'Duelo de modelos',
  lede: 'Escolha de {min} a {max} modelos. Cada um desenha o mesmo briefing no seu próprio frame, lado a lado.',
  briefPlaceholder: 'O que cada modelo deve desenhar?',
  noModels: 'Conecte uma conta de modelo nas Configurações para fazer um duelo.',
  start: { one: 'Começar com {count} modelo', other: 'Começar com {count} modelos' },
  starting: 'Começando…',
  started: { one: 'Duelo iniciado com {count} modelo', other: 'Duelo iniciado com {count} modelos' },
  failed: 'Não foi possível iniciar o duelo.',
  cancel: 'Cancelar',
} as const
