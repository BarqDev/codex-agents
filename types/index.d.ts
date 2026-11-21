export type RunState = 'running' | 'done' | 'failed'

export type RunView = {
  id: string
  name: string
  model: string
  effort: string
  sandbox: string
  dir: string
  state: RunState
  rc: number | null
  startedMs: number
  endedMs: number | null
  /** The newest progress lines, oldest first, timestamps stripped. */
  lines: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'codex-agents': {
      runs: RunView[]
      /** The run whose recent steps are shown in full, or null. */
      expanded: string | null
      /** Wall clock of the last poll, so elapsed times tick while drawn. */
      now: number
    }
  }
}
