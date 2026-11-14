/** As verificações do frame (responsivo + acessibilidade): o selo no nome do
 *  frame e o bloco na seção Qualidade do Inspector. */
export const checks = {
  badgeLabel: 'A11y',
  badgeTitle: 'Verificações do frame em 375 / 768 / 1440',
  clean: 'Sem problemas nas verificações',
  issueCount: { one: '{count} problema de verificação', other: '{count} problemas de verificação' },
  scoreLabel: 'nota {score}/100',
  heading: 'Responsivo e acessibilidade',
  notChecked: 'Ainda não verificado: as verificações rodam no renderizador após cada mudança.',
  noIssues: 'Sem problemas em 375, 768 ou 1440px, e a navegação por teclado passa.',
  widthRow: '{width}px',
  widthIssues: { one: '{count} problema', other: '{count} problemas' },
  widthOverflow: 'rola {px}px para o lado',
  widthClean: 'ok',
  focusSummary: 'Teclado: {reached}/{focusables} alcançados, {hidden} sem foco visível',
  focusUnavailable: 'A navegação por teclado não rodou',
  run: 'Verificar',
  running: 'Verificando…',
  runFailed: 'As verificações não puderam rodar (sem renderizador neste servidor?)',
  stale: 'O design mudou desde este resultado',
  allWidths: 'todas as larguras',
  keyboard: 'teclado',
} as const
