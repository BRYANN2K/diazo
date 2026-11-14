/** Replay de execução: a linha do tempo de uma execução de agente, o antes e
 *  o depois de cada frame que ela tocou, e o rollback da execução inteira. */
export const replay = {
  title: 'Execução de {agent}',
  lede: 'Tudo o que esta execução fez, do mais antigo ao mais recente, e cada frame que ela tocou como era antes e depois.',
  loading: 'Carregando a execução…',
  failed: 'Não foi possível carregar esta execução.',
  timeline: 'Linha do tempo',
  noEvents: 'Esta execução não registrou atividade.',
  frames: 'Frames',
  noFrames: 'Esta execução não mudou nenhum frame.',
  before: 'Antes',
  after: 'Depois',
  createdByRun: 'Criado por esta execução',
  deletedSince: 'Excluído desde então',
  editedSince: 'Editado depois da execução',
  openRun: 'Abrir a execução',
  close: 'Fechar',
} as const
