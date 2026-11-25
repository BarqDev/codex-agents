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
  "-x (full access with network: browser QA, deploy checks), -U (load the user's Codex config: its document skills for Word, Excel, PowerPoint and PDF files),",
  "-e low|medium|high (effort), -C <dir> (working directory). It cannot drive the user's Chrome: that stays with Claude.",
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
const FLAG_ALONE = new Set(['-w', '-x', '-N', '-U'])

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

// What the engine inserts around a caller's words, kept out of tasks: system reminders, hand-back
// nags, and the wrapper on a message sent while the agent was working.
const COORDINATOR = /^\s*The coordinator sent a message while you were working:\s*([\s\S]*?)\s*(?:Address this before completing your current task\.?)?\s*$/
export function clean(text: string): string {
  const kept = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .split('\n')
    .filter(line => !/^\s*\[handback-[a-z-]+\]/.test(line))
    .join('\n')
    .trim()
  return kept.match(COORDINATOR)?.[1]?.trim() ?? kept
}

// The original task without any relayed message the engine merged into it: those are follow-ups,
// counted on their own.
const RELAYED = /The coordinator sent a message while you were working:[\s\S]*?(?:Address this before completing your current task\.?|$)/g
const withoutRelayed = (text: string) => text.replace(RELAYED, '').trim()

// The agent's transcript as the model would be sent it (`as: "api"`): unlike the row form, it holds
// what the engine inserted, such as messages that arrived while a Codex run was going.
type ApiMessage = { role: string; content: unknown }
type Block = { type?: string; text?: string; name?: string; id?: string; input?: unknown; tool_use_id?: string; content?: unknown }
export function fromApi(api: readonly ApiMessage[]): SessionMessage[] {
  return api.map(m => {
    const blocks: Block[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : ((m.content as Block[]) ?? [])
    const text = blocks
      .filter(b => b.type === 'text')
      .map(b => b.text ?? '')
      .join('\n')
    const toolUses = blocks
      .filter(b => b.type === 'tool_use')
      .map(b => ({ tool_use_id: b.id ?? '', tool: b.name ?? '', input: (b.input ?? {}) as Record<string, unknown> }))
    const toolResults = blocks
      .filter(b => b.type === 'tool_result')
      .map(b => ({ tool_use_id: b.tool_use_id ?? '', text: typeof b.content === 'string' ? b.content : '' }))
    const role = m.role === 'assistant' ? 'assistant' : 'user'
    return { role, text, toolUses, ...(toolResults.length ? { toolResults } : {}) } as SessionMessage
  })
}

const isHandback = (m: SessionMessage) => m.role === 'assistant' && m.toolUses.some(t => t.tool === HANDBACK)
const handbackText = (m: SessionMessage) =>
  String(m.toolUses.find(t => t.tool === HANDBACK)?.input?.message ?? '')
// A message with words from the caller (the task, or a SendMessage), even beside a tool result.
const isFromCaller = (m: SessionMessage) => m.role === 'user' && clean(m.text) !== ''

// What this step has to do, read from the agent's own transcript so nothing lives in memory:
// - `end`: the hand-back's result just came back; end the turn with the answer as its last text.
// - `again`: nothing new since the last hand-back, but the engine wants one: hand the answer back again.
// - `run`: run Codex on every message sent since the last answer (all of them on the first turn).
type Plan =
  | { kind: 'end'; answer: string }
  | { kind: 'again'; answer: string }
  | { kind: 'run'; flags: string[]; task: string; first: string; followUp: boolean }

// `queued` holds messages sent to the agent (caught at `session.send`) that its transcript does not
// show yet: one sent while Codex ran reaches the transcript only as an engine-inserted message the
// hook cannot read at step time.
export function plan(messages: SessionMessage[], queued: readonly string[] = []): Plan | null {
  const callers = messages.filter(isFromCaller)
  const first = callers[0]
  if (!first) return null
  const lastHandback = [...messages].reverse().find(isHandback)
  // Since the last hand-back: only its tool result and what the engine inserted, no caller words.
  const after = lastHandback ? messages.slice(messages.indexOf(lastHandback) + 1) : []
  if (
    lastHandback &&
    queued.length === 0 &&
    after.some(m => m.toolResults?.length) &&
    after.every(m => m.role === 'user' && !isFromCaller(m))
  )
    return { kind: 'end', answer: handbackText(lastHandback) }

  const { flags, body } = parseHeader(clean(withoutRelayed(first.text)))
  if (!lastHandback) return { kind: 'run', flags, task: body, first: body, followUp: false }
  const seen = after.filter(isFromCaller).map(m => clean(m.text))
  // A queued message the transcript already shows counts once.
  const fresh = [...seen, ...queued.map(t => t.trim()).filter(t => t && !seen.includes(t))]
  if (fresh.length === 0) return { kind: 'again', answer: handbackText(lastHandback) }
  const task = [
    'You are continuing earlier work. The original task, for context:',
    body.trim(),
    'Your previous answer, for context:',
    handbackText(lastHandback).slice(0, 6000),
    fresh.length > 1 ? `New messages, in the order they were sent (${fresh.length}):` : 'New message:',
    fresh.map((t, i) => (fresh.length > 1 ? `${i + 1}. ${t}` : t)).join('\n\n'),
  ].join('\n\n')

  return { kind: 'run', flags, task, first: body, followUp: true }
}

export function registerCodexSubagent(on: On) {
  // Prompts this module sent to a Codex agent: its first turn is known before the engine lists
  // the agent or its transcript holds the mark.
  const spawned = new Set<string>()
  // Messages sent to each Codex agent and not yet run, in the order they were sent.
  const queued = new Map<string, string[]>()

  // Catch every message sent to a Codex agent, so one sent while Codex runs is not lost.
  on('session.send', async ($, e, next) => {
    const agents = await $.agent.list().catch(() => [])
    const agent = agents.find(a => a.type === AGENT && (a.id === e.to || a.id.startsWith(e.to) || e.to.startsWith(a.id)))
    if (agent) queued.set(agent.id, [...(queued.get(agent.id) ?? []), e.text])

    return next(e)
  })

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
    const read = await $.session.messages({ agentId: e.agentId, as: 'api' })
    const messages = 'deny' in read ? [] : fromApi(read as readonly ApiMessage[])
    // A Codex agent by its type, or, once the engine stops listing it, by the mark in its transcript.
    const agent = (await $.agent.list()).find(a => a.id === e.agentId)
    const firstText = clean(messages.find(isFromCaller)?.text ?? '')
    const ours =
      agent?.type === AGENT ||
      spawned.has(firstText) ||
      messages.some(m => m.role === 'assistant' && m.text.startsWith(MARK))
    if (!ours) return yield* next(e)

    const todo = plan(messages, queued.get(e.agentId) ?? [])
    // The queued messages are in this run's task now.
    if (todo?.kind === 'run' && todo.followUp) queued.delete(e.agentId)
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
    // Hand an answer back as a SubagentHandback call: the engine counts a report as delivered only
    // through it, and asks again otherwise.
    const handBack = function* (answer: string) {
      const input = { message: answer }
      const id = `toolu_codex_${crypto.randomUUID().replace(/-/g, '')}`
      yield { kind: 'tool' as const, index: 1, id, name: HANDBACK }
      yield { kind: 'input' as const, index: 1, json: JSON.stringify(input) }
      yield { kind: 'stop' as const, stopReason: 'tool_use' as const, usage: null }
      return { name: HANDBACK, input }
    }
    // Never fall through to the placeholder model, and never answer without a hand-back.
    if (!todo || todo.kind === 'again') {
      const answer =
        todo?.answer ||
        `Codex agent did not run: ${'deny' in read ? `its transcript could not be read (${read.deny})` : 'it found no task'}. Send the task again as a new message.`
      const use = yield* handBack(answer)
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [use], stopReason: 'tool_use', usage: null }
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
    const use = yield* handBack(answer)

    return { turnId: e.turnId, index: e.index, answer: steps, toolUses: [use], stopReason: 'tool_use', usage: null }
  })
}
