import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RunState, RunView } from '../types'
import { registerGuidance } from './guidance'
import { registerCodexAgentType, registerCodexSubagent, wrapperPath } from './subagent'

const PANE = 'codex-agents'
const TITLE = 'Codex agents'
const runs = atom({ plugin: 'codex-agents', key: 'runs' } as const, [])
const expanded = atom({ plugin: 'codex-agents', key: 'expanded' } as const, null)
const now = atom({ plugin: 'codex-agents', key: 'now' } as const, 0)

// Finished runs stay listed this long; running ones always show.
const KEEP_FINISHED_MS = 2 * 60 * 60 * 1000
const MAX_RUNS = 12
const TAIL_LINES = 14

function parse(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function elapsed(run: RunView, nowMs: number): string {
  const s = Math.max(0, Math.round(((run.endedMs ?? nowMs) - run.startedMs) / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

const ICON: Record<RunState, string> = { running: '●', done: '✓', failed: '✗' }
const COLOR: Record<RunState, string> = { running: 'warning', done: 'success', failed: 'error' }

// Runs the bundled wrapper's own check: Codex CLI, login, model list and tiers.
async function doctor($: EngineInterface): Promise<{ ok: boolean; text: string }> {
  const r = await $.process.run([wrapperPath($.plugin.root), 'doctor'], { timeoutMs: 30_000 })
  return { ok: r.exitCode === 0, text: `${r.stdout}${r.stderr}`.trim() }
}

export const register: Register = on => {
  registerCodexSubagent(on)
  registerGuidance(on)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'codex-agents',
      description: 'Show the Codex subagents panel (codex-agent runs, live)',
    })
    await $.command.register({
      name: 'codex-setup',
      description: 'Check that Codex subagents can run here (Codex CLI, login, models)',
    })
    // The subagent type is optional: the panel keeps working if registering it is refused.
    await registerCodexAgentType($).catch(err =>
      $.ui.status(`codex-agents: codex subagent type not registered: ${String(err).slice(0, 120)}`),
    )
    // A quiet check per session: only a problem is shown, pointing at /codex-setup.
    void doctor($)
      .then(r => r.ok || $.ui.status('codex-agents: Codex is not ready here. Run /codex-setup'))
      .catch(() => $.ui.status('codex-agents: could not run the Codex check. Run /codex-setup'))

    const home = (await $.env.get('HOME')) ?? ''
    const runsDir = `${home}/.claude/cache/codex-runs`
    const cwd = e.cwd
    const sessionStartMs = await $.clock.now()
    const seen = new Set<string>()
    let lastSig = ''
    let polling = false

    const poll = async () => {
      if (polling) return
      polling = true
      try {
        const t = await $.clock.now()
        if (!(await $.fs.exists(runsDir))) return
        const dirs = (await $.fs.list(runsDir))
          .filter(d => d.kind === 'dir')
          .map(d => d.name)
          .sort()
          .slice(-40)
        const views: RunView[] = []
        for (const id of dirs) {
          const base = `${runsDir}/${id}`
          const meta = parse(await $.fs.read(`${base}/meta.json`).catch(() => ''))
          if (!meta) continue
          const status = parse(await $.fs.read(`${base}/status.json`).catch(() => '')) ?? {}
          const state: RunState = status.state === 'done' || status.state === 'failed' ? status.state : 'running'
          const endedMs = typeof status.ended === 'number' ? status.ended * 1000 : null
          if (state !== 'running' && endedMs !== null && t - endedMs > KEEP_FINISHED_MS) continue
          const log = await $.fs.read(`${base}/progress.log`).catch(() => '')
          views.push({
            id,
            name: String(meta.name ?? id),
            model: String(meta.model ?? ''),
            effort: String(meta.effort ?? ''),
            sandbox: String(meta.sandbox ?? ''),
            dir: String(meta.dir ?? ''),
            state,
            rc: typeof status.rc === 'number' ? status.rc : null,
            startedMs: Number(meta.started ?? 0) * 1000,
            endedMs,
            lines: log.split('\n').filter(l => l.trim()).slice(-TAIL_LINES),
          })
        }
        const shown = views.slice(-MAX_RUNS).reverse()

        // Open the pane when an agent for this project starts after the session did.
        const fresh = shown.find(
          r => r.state === 'running' && !seen.has(r.id) && r.startedMs >= sessionStartMs && r.dir.startsWith(cwd),
        )
        shown.forEach(r => seen.add(r.id))
        if (fresh) void $.ui.open({ id: PANE, title: TITLE })

        const sig = JSON.stringify(shown)
        if (sig !== lastSig) {
          lastSig = sig
          await update($, runs, () => shown)
        }
        if (shown.some(r => r.state === 'running')) await update($, now, () => t)
      } catch (err) {
        // A refused or failed read skips this tick; the next one tries again.
        $.ui.status(`codex-agents: ${String(err).slice(0, 120)}`)
      } finally {
        polling = false
      }
    }

    void poll()
    $.clock.every(1000, () => void poll())

    return next(e)
  })

  on('command.run', { command: 'codex-setup' }, async $ => {
    const r = await doctor($).catch(err => ({ ok: false, text: `Could not run the check: ${String(err)}` }))
    if (r.ok) $.ui.status(undefined)
    return { text: r.text }
  })

  on('command.run', { command: 'codex-agents' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Codex agents panel opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, runs)
    const open = await read($, expanded)
    const nowMs = Math.max(await read($, now), await $.clock.now())
    const running = list.filter(r => r.state === 'running').length

    return (
      <Box flexDirection="column">
        <Text dimColor>
          {running} running · {list.length - running} finished (last 2h) · click a row for its steps
        </Text>
        {list.length === 0 && (
          <Text dimColor>No Codex agents yet. They appear here when Claude runs codex-agent.</Text>
        )}
        {list.map(run => {
          const isOpen = open === run.id
          const latest = (run.lines.at(-1) ?? 'starting…').replace(/^\d\d:\d\d:\d\d /, '')
          return (
            <Box flexDirection="column" marginTop={1}>
              <Button
                key={run.id}
                plain
                onPress={() => update($, expanded, cur => (cur === run.id ? null : run.id))}
              >
                <Text color={COLOR[run.state]}>{ICON[run.state]}</Text> <Text weight="semibold">{run.name}</Text>{' '}
                <Text dimColor>
                  {elapsed(run, nowMs)}
                  {run.state === 'failed' ? ` · exit ${run.rc}` : ''}
                </Text>
              </Button>
              {!isOpen && (
                <Text dimColor wrap="truncate-end">
                  {latest}
                </Text>
              )}
              {isOpen && (
                <Box flexDirection="column">
                  <Text dimColor>
                    {run.model} · {run.effort} · {run.sandbox} · {run.dir.split('/').slice(-2).join('/')}
                  </Text>
                  {run.lines.map(line => (
                    <Text mono size="footnote">
                      {line}
                    </Text>
                  ))}
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}
