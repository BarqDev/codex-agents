import type { EngineInterface, On, SessionMessage } from 'claude-code'

// A Claude subagent type whose every model turn is answered by OpenAI Codex (through the bundled
// scripts/codex-agent) instead of a Claude request: it shows in Claude's own subagent view,
// streams Codex's steps live, and hands back Codex's answer.
export const AGENT = 'codex-agents:codex'

const DESCRIPTION = [
  'Runs the task on an OpenAI Codex agent (GPT Sol/Terra/Luna) instead of a Claude model, so it uses none of',
  "Claude's rate limits. Prefer it over general-purpose or Explore for delegable work: code search and reading,",
  'independent implementation pieces, writing tests, bulk mechanical edits, second-opinion reviews, research summaries.',
  'It cannot use Claude-only tools (MCP connectors, the browser pane, Artifacts). The prompt must be self-contained:',
  'goal, exact files or paths, constraints, and what the answer must contain.',
  'Read-only by default. Optional first line of the prompt: `codex: <flags>` with',
  '-t sol|terra|luna (model tier; default sol, terra when the Agent call passes model "sonnet", luna for "haiku"),',
  '-w (may edit files in the working directory), -N (with -w: network on, e.g. a local database for tests),',
  '-x (full access with network: browser QA, deploy checks), -e low|medium|high (effort), -C <dir> (working directory).',
  'SendMessage to it after it finished starts a new Codex run with every message sent since its last answer.',
].join(' ')

// Never sent: every turn of this agent is answered by the turn.step hook below.
const SYSTEM_PROMPT = 'This agent is answered by OpenAI Codex through the codex-agents plugin.'

// A subagent delivers its final report to its caller by calling this tool with `{ message }`.
const HANDBACK = 'SubagentHandback'

// The first line of every Codex turn's text: it names the real model, and marks the agent as a
// Codex one in its own transcript, so a turn is recognized even after a reload.
const MARK = '**Codex** ·'

const FLAG_WITH_VALUE = new Set(['-t', '-e', '-C', '-n'])
const FLAG_ALONE = new Set(['-w', '-x', '-N'])

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

const isHandback = (m: SessionMessage) => m.role === 'assistant' && m.toolUses.some(t => t.tool === HANDBACK)
const handbackText = (m: SessionMessage) =>
  String(m.toolUses.find(t => t.tool === HANDBACK)?.input?.message ?? '')
// A message the caller sent (the task, or a SendMessage), not a tool result.
const isFromCaller = (m: SessionMessage) => m.role === 'user' && !m.toolResults?.length && m.text.trim() !== ''

// What this step has to do, read from the agent's own transcript so nothing lives in memory:
// - `end`: the hand-back's result just came back; end the turn with the answer as its last text.
// - `run`: run Codex on every message sent since the last answer (all of them on the first turn).
type Plan = { kind: 'end'; answer: string } | { kind: 'run'; flags: string[]; task: string; first: string }

export function plan(messages: SessionMessage[]): Plan | null {
  const callers = messages.filter(isFromCaller)
  const first = callers[0]
  if (!first) return null
  const last = messages.at(-1)
  const lastHandback = [...messages].reverse().find(isHandback)
  if (lastHandback && last?.role === 'user' && last.toolResults?.length && lastHandback === messages.at(-2))
    return { kind: 'end', answer: handbackText(lastHandback) }

  const { flags, body } = parseHeader(first.text)
  if (!lastHandback) return { kind: 'run', flags, task: body, first: body }
  const fresh = messages
    .slice(messages.indexOf(lastHandback) + 1)
    .filter(isFromCaller)
    .map(m => m.text.trim())
  if (fresh.length === 0) return null
  const task = [
    'You are continuing earlier work. The original task, for context:',
    body.trim(),
    'Your previous answer, for context:',
    handbackText(lastHandback).slice(0, 6000),
    fresh.length > 1 ? `New messages, in the order they were sent (${fresh.length}):` : 'New message:',
    fresh.map((t, i) => (fresh.length > 1 ? `${i + 1}. ${t}` : t)).join('\n\n'),
  ].join('\n\n')

  return { kind: 'run', flags, task, first: body }
}

export function registerCodexSubagent(on: On) {
  // Prompts this module sent to a Codex agent: its first turn is known before the engine lists
  // the agent or its transcript holds the mark.
  const spawned = new Set<string>()

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
    spawned.add(prompt.trim())

    return next({ ...e, prompt, model: 'haiku' })
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) return yield* next(e)
    const read = await $.session.messages({ agentId: e.agentId })
    const messages = 'deny' in read ? [] : read
    // A Codex agent by its type, or, once the engine stops listing it, by the mark in its transcript.
    const agent = (await $.agent.list()).find(a => a.id === e.agentId)
    const firstText = messages.find(isFromCaller)?.text.trim() ?? ''
    const ours =
      agent?.type === AGENT ||
      spawned.has(firstText) ||
      messages.some(m => m.role === 'assistant' && m.text.startsWith(MARK))
    if (!ours) return yield* next(e)

    const todo = plan(messages)
    const finish = (answer: string) => ({
      turnId: e.turnId,
      index: e.index,
      answer,
      toolUses: [] as { name: string; input: unknown }[],
      stopReason: 'end_turn' as const,
      usage: null,
    })

    // Sessions with SubagentHandback (the desktop app, auto mode) deliver the hand-back; the others
    // (headless `claude -p`, where that tool call fails) take an agent's last text as its result.
    if (todo?.kind === 'end') {
      yield { kind: 'text', index: 0, text: todo.answer }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return finish(todo.answer)
    }
    // Never fall through to the placeholder model: say what is wrong as the agent's answer.
    if (!todo) {
      const why = 'deny' in read ? `its transcript could not be read (${read.deny})` : 'no new message to run'
      const answer = `Codex agent did not run: ${why}. Send the task again as a new message.`
      yield { kind: 'text', index: 0, text: answer }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return finish(answer)
    }

    const cwd = await $.session.cwd()
    const name = slug(agent?.description || todo.first)
    const argv = [wrapperPath($.plugin.root), 'run', '-v', '-n', name, '-C', cwd, ...todo.flags, '-']

    // Codex's steps stream as the agent's own text, so they stay in its view after it ends;
    // only the hand-back report reaches the caller.
    // No usage is reported: the engine books a step's usage under the subagent's Claude model
    // (haiku), which would count Codex's tokens as Claude usage. The steps show Codex's own count.
    let steps = ''
    let out = ''
    let errTail = ''
    let failure = ''
    const step = (line: string): string | null => {
      const head = line.match(/^▶ (\S+) · (.*)$/)
      // The view's own model label names the haiku placeholder; this line names the real model.
      if (head) return `${MARK} \`${head[1]}\` · ${head[2]}\n\n`
      const text = line.trim()
      if (!text) return null
      if (text.startsWith('$ ')) return `- \`${text.replace(/`/g, "'")}\`\n`
      return line.startsWith('  ') ? `  - ${text}\n` : `- ${text}\n`
    }

    try {
      const child = $.process.spawn({ argv, input: todo.task })
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
    yield { kind: 'tool', index: 1, id, name: HANDBACK }
    yield { kind: 'input', index: 1, json: JSON.stringify(input) }
    yield { kind: 'stop', stopReason: 'tool_use', usage: null }

    return { turnId: e.turnId, index: e.index, answer: steps, toolUses: [{ name: HANDBACK, input }], stopReason: 'tool_use', usage: null }
  })
}
