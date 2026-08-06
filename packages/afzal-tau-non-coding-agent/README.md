# afzal-tau-non-coding-agent

A local-model knowledge-work profile for [Pi](https://pi.dev), built from the fork-specific [Tau](https://github.com/AfzalivE/tau) package.

## Purpose

Use this package to run Pi in non-code sources, especially personal Obsidian vaults, and then extract reusable patterns from those sessions. Running `/insights scope=project` from the source root analyzes Pi sessions associated with that working directory and suggests reusable instructions, templates, skills, and extensions.

The package keeps the complete `afzal-tau-all-agent` extension set while limiting bundled skills to `browser-tools`.

## Install

```bash
pi install npm:afzal-tau-non-coding-agent
```

## Local models

The package does not bundle or select a model. Configure a local provider in `~/.pi/agent/models.json`; Pi supports OpenAI-compatible servers such as Ollama, LM Studio, and vLLM.

For example:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [{ "id": "llama3.1:8b" }]
    }
  }
}
```

Select the configured model with `/model` before running `/insights`; `/insights` uses the active Pi model.

## Extensions

This package intentionally matches the `afzal-tau-all-agent` extension manifest.

| Extension           | Command              | Description                                                                                                               |
| ------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `answer`            | `/answer`            | Extract and interactively answer agent questions.                                                                         |
| `branch-term`       | `/branch`            | Open a new terminal on the current session's git branch.                                                                  |
| `btw`               | `/btw`               | Run a one-off side request with read-only tools and no context persistence.                                               |
| `tool-display-mode` | `ctrl+o`             | Cycle tool output between Pi's default rendering, expanded output, and compact summaries.                                 |
| `raw`               | `/raw`, `alt+r`      | Open the full active-branch transcript in terminal scrollback for copying.                                                |
| `converge`          | `/converge`          | Run multiple planner personas and synthesize one recommended plan.                                                        |
| `ghostty`           | —                    | Ghostty tab title enhancements while the agent is working, waiting, or idle.                                              |
| `git-diff-stats`    | —                    | Status bar diff stats for local changes in the current repo.                                                              |
| `git-pr-status`     | —                    | Status bar PR number and link for the current branch.                                                                     |
| `insights`          | `/insights`          | Analyze Pi sessions and suggest reusable instructions, templates, skills, and extensions.                                 |
| `stash`             | `alt+x`              | Stash the current message draft, send one message, then restore it.                                                       |
| `loop`              | `/loop`              | Repeat a prompt until the agent signals success.                                                                          |
| `notify`            | —                    | Terminal notification when the agent is waiting for input.                                                                |
| `openai-fast`       | `/fast`              | Toggle priority service tier for supported OpenAI models.                                                                 |
| `openai-verbosity`  | `/verbosity`         | Set verbosity for supported OpenAI models.                                                                                |
| `review`            | `/review`, `/triage` | Multi-focus review and PR feedback triage for PRs, branches, commits, and local changes, with integrated follow-up fixes. |
| `sandbox`           | `/sandbox`           | OS-level bash sandboxing plus filesystem guardrails for native Pi file tools.                                             |
| `spotlight`         | `/spotlight`         | Mirror a linked worktree into the main worktree while you work elsewhere.                                                 |
| `telegram`          | `/telegram`          | Interact with Pi via a Telegram bot, mirror output, and send files from local sessions.                                   |
| `todoist`           | `/todoist`           | Todoist-backed tasks with offline outbox sync for single or multi-session work.                                           |
| `usage`             | `/usage`             | Historical provider usage breakdown with all-provider history and live quota snapshots.                                   |
| `websearch`         | —                    | Web search via Gemini, OpenAI, or Claude, leveraging Pi or browser session credentials.                                   |
| `worktree`          | `/worktree`          | Create, list, and archive git worktrees, optionally opening them in a new terminal or tmux pane.                          |

## Skills

| Skill           | Description                                                  |
| --------------- | ------------------------------------------------------------ |
| `browser-tools` | Interactive browser automation via Chrome DevTools Protocol. |

## Themes

| Theme      | Description                                                   |
| ---------- | ------------------------------------------------------------- |
| `tau-dark` | Pi's official dark theme with a calmer, more cohesive polish. |

## Agent configuration

Tau does not include agent configuration; configure Pi with your own `AGENTS.md`, `settings.json`, sandbox config, and model preferences.
