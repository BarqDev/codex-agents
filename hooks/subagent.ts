import type { EngineInterface, On } from 'claude-code'

// A Claude subagent type whose every model turn is answered by OpenAI Codex (through
// ~/.claude/scripts/codex-agent) instead of a Claude request: it shows in Claude's own
// subagent view, streams Codex's steps live as thinking, and hands back Codex's answer.
export const AGENT = 'codex-agents:codex'

const DESCRIPTION = [
  'Runs the task on an OpenAI Codex agent (GPT Sol/Terra/Luna) instead of a Claude model, so it uses none of',
  "Claude's rate limits. Prefer it over general-purpose or Explore for delegable work: code search and reading,",
  'independent implementation pieces, writing tests, bulk mechanical edits, second-opinion reviews, research summaries.',
  'It cannot use Claude-only tools (MCP connectors, the browser pane, Artifacts). The prompt must be self-contained:',
  'goal, exact files or paths, constraints, and what the answer must contain.',
  'Read-only by default. Optional first line of the prompt: `codex: <flags>` with',
  '-t sol|terra|luna (model tier; default sol, terra when the Agent call passes model "sonnet", luna for "haiku"),',
  '-w (may edit files in the working directory), -x (full access with network: browser QA, deploy checks),',
  '-e low|medium|high (effort), -C <dir> (working directory).',
].join(' ')

// Never sent: every turn of this agent is answered by the turn.step hook below.
const SYSTEM_PROMPT = 'This agent is answered by OpenAI Codex through the codex-agents plugin.'

// A subagent delivers its final report to its caller by calling this tool with `{ message }`.
const HANDBACK = 'SubagentHandback'

const FLAG_WITH_VALUE = new Set(['-t', '-e', '-C', '-n'])
const FLAG_ALONE = new Set(['-w', '-x'])

// `reported` is the turn whose report was handed back, and `answer` that report: the turn's next
// step ends it with the answer as its last text.
type Run = { flags: string[]; task: string; name: string; turns: number; reported: string | null; answer: string }

function parseHeader(prompt: string): { flags: string[]; body: string } {
  const m = prompt.match(/^\s*codex:([^\n]*)\n?/i)
  if (!m) return { flags: [], body: prompt }
  const words = (m[1] ?? '').match(/"[^"]*"|\S+/g) ?? []
  const flags: string[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? ''
    if (FLAG_ALONE.has(w)) flags.push(w)
    // A value is the next word unless that word is itself a flag (`-t -w` leaves -t out).
    else if (FLAG_WITH_VALUE.has(w) && words[i + 1] && !words[i + 1]?.startsWith('-'))
      flags.push(w, (words[++i] ?? '').replace(/^"|"$/g, ''))
  }
  return { flags, body: prompt.slice(m[0].length) }
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 28) || 'codex'
  )
}

// The wrapper ships inside the plugin, so an install needs nothing else on disk.
export function wrapperPath(root: string): string {
  return `${root}/scripts/codex-agent`
}

// Called from the module's one session.start hook.
export async function registerCodexAgentType($: EngineInterface) {
  await $.agent.register({
    name: 'codex',
    description: DESCRIPTION,
    prompt: SYSTEM_PROMPT,
    // Its turns call no tool but SubagentHandback, which the engine gives every subagent and a
    // tools list cannot name; Read is listed only so the list is not empty (empty means all tools).
    tools: ['Read'],
    // A cheap model in case a turn ever reaches Claude; the turn.step hook answers them all.
    model: 'haiku',
  })
}

export function registerCodexSubagent(on: On) {
  const runs = new Map<string, Run>()

  // Turn the Agent call's model alias into a tier, and keep the subagent itself on haiku.
  on('agent.spawn', async ($, e, next) => {
    if (e.subagentType !== AGENT) return next(e)
    const alias = (e.model ?? '').toLowerCase()
    const tier = alias.includes('sonnet') ? 'terra' : alias.includes('haiku') ? 'luna' : ''
    const hasHeader = /^\s*codex:/i.test(e.prompt)
    const hasTier = parseHeader(e.prompt).flags.includes('-t')
    const prompt =
      tier && !hasTier
        ? hasHeader
          ? e.prompt.replace(/^\s*codex:/i, `codex: -t ${tier}`)
          : `codex: -t ${tier}\n${e.prompt}`
        : e.prompt

    return next({ ...e, prompt, model: 'haiku' })
  })

  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    if (!e.agentId) return started
    const agent = (await $.agent.list()).find(a => a.id === e.agentId)
    if (agent?.type !== AGENT) return started
    const prior = runs.get(e.agentId)
    if (prior) {
      // A message that woke the agent again: a new Codex task carrying the first one as context.
      prior.turns += 1
      prior.task = `Earlier task, for context:\n${prior.task}\n\nNew message:\n${e.text}`
    } else {
      const { flags, body } = parseHeader(e.text)
      runs.set(e.agentId, { flags, task: body, name: slug(agent.description || body), turns: 1, reported: null, answer: '' })
    }

    return started
  })

  on('turn.step', async function* ($, e, next) {
    const run = e.agentId ? runs.get(e.agentId) : undefined
    if (!run) return yield* next(e)

    // The step after the hand-back's tool result ends the turn with the answer as its last text.
    // Sessions with SubagentHandback (the desktop app, auto mode) deliver the hand-back; the others
    // (headless `claude -p`, where that tool call fails) take an agent's last text as its result.
    if (run.reported === e.turnId) {
      yield { kind: 'text', index: 0, text: run.answer }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return { turnId: e.turnId, index: e.index, answer: run.answer, toolUses: [], stopReason: 'end_turn', usage: null }
    }

    const cwd = await $.session.cwd()
    const argv = [wrapperPath($.plugin.root), 'run', '-v', '-n', run.name, '-C', cwd, ...run.flags, '-']

    // Codex's steps stream as the agent's own text, so they stay in its view after it ends;
    // only the SubagentHandback report reaches the caller.
    // No usage is reported: the engine books a step's usage under the subagent's Claude model
    // (haiku), which would count Codex's tokens as Claude usage. The steps show Codex's own count.
    let steps = ''
    let out = ''
    let errTail = ''
    let failure = ''
    const step = (line: string): string | null => {
      const head = line.match(/^▶ (\S+) · (.*)$/)
      // The view's own model label names the haiku placeholder; this line names the real model.
      if (head) return `**Codex** · \`${head[1]}\` · ${head[2]}\n\n`
      const text = line.trim()
      if (!text) return null
      if (text.startsWith('$ ')) return `- \`${text.replace(/`/g, "'")}\`\n`
      return line.startsWith('  ') ? `  - ${text}\n` : `- ${text}\n`
    }

    try {
      const child = $.process.spawn({ argv, input: run.task })
      let pending = ''
      for await (const piece of child) {
        if (piece.stream === 'stdout') {
          out += piece.text
          continue
        }
        // Each stderr line is one live step (the wrapper's -v progress).
        pending += piece.text
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) {
          errTail = (errTail + line + '\n').slice(-2000)
          const shown = step(line)
          if (shown) {
            steps += shown
            yield { kind: 'text', index: 0, text: shown }
          }
        }
      }
      const last = pending.trim() ? step(pending) : null
      if (last) {
        steps += last
        yield { kind: 'text', index: 0, text: last }
      }
      const end = await child.result
      if (end.code !== 0 || !out.trim()) failure = `exit ${end.code ?? end.signal}`
    } catch (err) {
      // The wrapper could not start (missing, not executable): still hand a report back.
      failure = `could not start ${argv[0]}: ${String(err).slice(0, 300)}`
    }

    const answer = failure
      ? `Codex agent failed (${failure}).\n\n${errTail.trim().slice(-1500)}`.trim()
      : out.trim()
    if (failure) {
      const note = `- ✗ ${failure}\n`
      steps += note
      yield { kind: 'text', index: 0, text: note }
    }

    // Hand the answer back the way a Claude subagent does: one SubagentHandback call.
    const input = { message: answer }
    const id = `toolu_codex_${crypto.randomUUID().replace(/-/g, '')}`
    run.reported = e.turnId
    run.answer = answer
    yield { kind: 'tool', index: 1, id, name: HANDBACK }
    yield { kind: 'input', index: 1, json: JSON.stringify(input) }
    yield { kind: 'stop', stopReason: 'tool_use', usage: null }

    return { turnId: e.turnId, index: e.index, answer: steps, toolUses: [{ name: HANDBACK, input }], stopReason: 'tool_use', usage: null }
  })
}
