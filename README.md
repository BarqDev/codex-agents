# codex-agents

Use OpenAI Codex as Claude Code subagents, so delegated work runs on your ChatGPT plan's Codex allowance instead of Claude's rate limits.

Once installed, there is nothing else to set up:

- **A `codex` subagent type.** Claude launches it with its normal Agent tool, like `Explore` or `general-purpose`. Every turn is answered by Codex, not a Claude model. It appears in the same subagent view, streams Codex's steps as it works, and hands its report back like any subagent.
- **Built-in guidance.** The plugin adds a short section to Claude's system prompt saying when to delegate to Codex, which tier to pick and how to write the prompt. You don't need to edit your `CLAUDE.md`.
- **A Codex agents panel** in the Claude desktop app: every Codex run with live status, elapsed time and latest step. It opens when an agent starts; `/codex-agents` opens it by hand.
- **`/codex-setup`** checks the Codex CLI, your login and the model list, and says what to fix.

## Requirements

- macOS or Linux with `python3`.
- Codex, logged in with ChatGPT. The ChatGPT desktop app bundles a current Codex CLI and is found automatically; a Codex CLI 0.100+ on your `PATH` works too, or set `CODEX_BIN`. An older Homebrew `codex` (0.9.x) is skipped.
- Open Codex once (the app, or any `codex` command) so it saves its model list.

## Install

The repository is private: you need read access to it on GitHub, and a git credential for github.com on your machine (an SSH key, or `gh auth login` then `gh auth setup-git`). The install never prompts for one.

At the prompt of a Claude Code terminal session:

```
/plugin install codex-agents --marketplace BarqDev/codex-agents
```

Answer `y` to add the marketplace, then pick the user scope. From a shell instead:

```bash
claude plugin install codex-agents --marketplace BarqDev/codex-agents
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `BarqDev/codex-agents`, then Add plugin.

Then run `/codex-setup` in a new session. It should end with `Ready: Codex subagents will work.`

### Turn it on for everyone working in a repo

Add this to the repo's `.claude/settings.json` and commit it. Claude Code then offers the plugin to anyone who opens the repo:

```json
{
  "extraKnownMarketplaces": {
    "barqdev-codex-agents": { "source": { "source": "github", "repo": "BarqDev/codex-agents" } }
  },
  "enabledPlugins": { "codex-agents@barqdev-codex-agents": true }
}
```

## Using it

Ask Claude to delegate ("have Codex agents check X and Y in parallel"), or let it choose. The guidance tells Claude to prefer Codex for delegable work.

- **Tier:** the Agent call's `model` picks it: `sonnet` = Terra (mid tier, routine work), `haiku` = Luna (trivial lookups), omitted = Sol (strongest non-frontier model, hard work). Each tier resolves to the newest Codex model of that family, so new releases are picked up automatically. Astra is never auto-picked.
- **Options:** an optional first prompt line, `codex: -t terra -w -e high -C /path`. Without an access flag it is read-only.
  - `-w` lets it edit files in the working directory, with no network (not even localhost).
  - `-N` is `-w` plus network. Use it for test suites that need a local database or service. Codex's sandbox can't limit this to localhost, so it is full network.
  - `-x` gives full access with network, for browser QA and the like.
  - `-U` loads your own Codex config (`~/.codex/config.toml`): the plugins and tools you enabled in Codex. In practice that adds the document skills (Word, Excel, PowerPoint, PDF files) and the runtime they use; pair it with `-w` so the files can be written. Without it a run starts from a clean config.
- **Connected apps:** your ChatGPT account's connected apps (Figma, Google Drive, Slack and so on) are available to every Codex agent, with or without `-U`.
- **Your Chrome (`-B`):** `codex: -B` runs the task inside the ChatGPT app, whose Codex can drive your own Chrome with your logins (through the "ChatGPT for Chrome" extension). Only the app grants its Codex that access, so the plugin hands the task to the app:
  - **One-time setup:** in the ChatGPT app, start a Codex thread, send it any message, and rename it **Claude bridge**. Each extra thread named **Claude bridge 2**, **Claude bridge 3** and so on lets one more browser task run at once; extra tasks wait for a free thread.
  - The plugin queues the task into a free bridge thread, streams its steps, and hands back the app's final answer. The app must be open, and its model and settings apply (other flags are ignored).
  - Each task tells Codex to ignore earlier tasks in the thread. When a thread gets long, replace it with a new one of the same name.
  - For testing your own app without your logins, `-x` lets Codex run Playwright in a separate headless browser instead.
- **Changed files:** a run that may write ends its report with the working tree's `git status --short`, so lockfiles and generated files show up even when the report forgets them.
- **Follow-ups:** SendMessage to a finished Codex agent starts one new Codex run with every message sent since its last answer, in order, plus the earlier task and answer as context.
- **Seeing progress:** the subagent view streams each agent's steps; the Codex agents panel lists every run; the status line shows how many Codex agents are running and the latest step of the longest one.
- **Model label:** the subagent view labels these agents with a Claude model (Haiku). That's a placeholder no request is sent to; the first line of the agent's output names the real Codex model.
- **From a shell:** the plugin's `scripts/codex-agent` runs Codex directly (`run`, `watch`, `ps`, `limits`, `models`, `doctor`). Run it with no arguments for usage. Run logs are kept in `~/.claude/cache/codex-runs/` for 7 days.

## Limits

- Codex's commands show as lines of text in the agent's view, not as separate tool-call rows.
- A follow-up starts a fresh Codex run: Codex gets the earlier task and answer as text, not its earlier working state.
- The usage limit that matters is your weekly Codex allowance. `codex-agent limits` shows it; when its last reading is over an hour old it makes a tiny probe call (about 10 seconds) to get a fresh one.
