// The transport-neutral entry points shared by MCP and resident tools.
export { executeScript as runScript, revertScriptRun as undoScript } from './scriptRunner.ts'
