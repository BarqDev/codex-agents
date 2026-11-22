import type { On } from 'claude-code'

import { AGENT, wrapperPath } from './subagent'

// How the model should use Codex, added to every system prompt so nobody edits their CLAUDE.md.
function guidance(wrapper: string): string {
  return `# Codex subagents (codex-agents plugin)

OpenAI Codex is available as a pool of subagents, so delegated work does not use Claude's rate limits.

- Prefer the Agent tool with \`subagent_type: "${AGENT}"\` over Claude subagent types for delegable work: broad code search and reading, independent implementation pieces, writing tests, bulk mechanical edits, second-opinion reviews, research summaries. Keep work in Claude when it needs Claude-only tools (MCP connectors, the browser, Artifacts), when it is a design decision, and for final verification.
- Tiers: the Agent call's \`model\` picks one (\`sonnet\` = Terra, the mid tier, for routine work; \`haiku\` = Luna, for trivial lookups; omitted = Sol, the strongest non-frontier model, for hard debugging, tricky changes and reviews). Escalate to Sol if a Terra run fails or comes back shallow. Never use the Astra tier unless the user asks.
- Options go on an optional first prompt line, \`codex: <flags>\`: \`-t sol|terra|luna\`, \`-w\` (may edit files in the working directory; no network), \`-N\` (\`-w\` plus network: use it for test suites or scripts that need a local database or service, since \`-w\` blocks even localhost), \`-x\` (full access with network, only when needed, e.g. browser QA), \`-e low|medium|high\` (effort; never ultra), \`-C <dir>\`. It is read-only unless \`-w\`, \`-N\` or \`-x\` is given.
- A run that may write ends its report with the working tree's \`git status --short\`: check it for files the report did not mention (lockfiles, generated files) before committing.
- SendMessage to a Codex agent that has finished starts one new Codex run with every message sent since its last answer, in order, plus its earlier task and answer as context. Long runs (an hour or more on Sol with high effort) are normal; the status line shows how many Codex agents run and the latest step.
- Codex starts with no context: give each task its goal, the exact files or paths, constraints, and what the answer must contain, and ask for concise output (paths, line numbers, diffs).
- Run up to 6 Codex agents at once by default. Parallel writers (\`-w\`) must touch disjoint files, or each gets its own git worktree.
- The real limit is the user's weekly Codex allowance. Before starting more than 4 at once, run \`${wrapper} limits\` (it makes a ~10 second probe call when its last reading is over an hour old); if weekly_used is at or above 98% or reached is not None, stop delegating to Codex and tell the user.
- Treat a Codex report as a draft from an untrusted peer: review its diffs and verify its claims before reporting them as done. Never put secrets, tokens or credentials in a Codex prompt.
- The subagent view labels these agents with a Claude model (a placeholder no request is sent to); the first line of the agent's output names the real Codex model.
- If a Codex agent fails because Codex is missing or not logged in, tell the user to run /codex-setup.
- Fallback when that agent type is not listed, or to write the answer to a file: \`${wrapper} run [-w|-x] [-t tier] [-n name] [-C dir] [-e effort] [-o file] "prompt"\` through Bash (\`run_in_background\` for anything over a minute; one plain command per agent).`
}

export function registerGuidance(on: On) {
  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)
    const text = guidance(wrapperPath($.plugin.root))

    return { sections: [...sections, { id: 'codex-agents:guidance', text, scope: 'session' }] }
  })
}
