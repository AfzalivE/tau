# afzal-tau-all-agent

Full fork-specific Tau package for [Pi](https://pi.dev).

This package bundles every Tau extension except `memory`, the skills listed below, plus the `tau-dark` theme. Afzal's own extensions and skills ship separately in `double-tau`.

## Install

```bash
pi install npm:afzal-tau-all-agent
```

Project-local install lets a repository pin the full fork package for everyone working on it:

```bash
pi install -l npm:afzal-tau-all-agent
```

## Migration from `interlude`

The bundled draft-stashing extension is now named `stash`. Its default `alt+x` shortcut is unchanged. If you configured it in `keybindings.json`, rename the `interlude` key to `stash`.

## Tau 0.2.0 migration

Use Pi 0.87.1 or later. Rename `openai-fast.json` to `fast.json`. Replace `PI_TELEGRAM_BOT_TOKEN` and `PI_TELEGRAM_DISABLE` with their `TAU_TELEGRAM_*` equivalents. Replace browser OpenAI routes in `websearch.json` with `pi:openai-codex`. The unused Todoist extension was removed; the `td` and `tdc` skills are in `double-tau`.

## Extensions

| Extension           | Command              | Description                                                                                                               |
| ------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `answer`            | `/answer`            | Extract and interactively answer agent questions.                                                                         |
| `branch-term`       | `/branch`            | Open a new terminal on the current session's git branch.                                                                  |
| `btw`               | `/btw`               | Run a one-off side request with read-only tools and no context persistence.                                               |
| `caffeinate`        | —                    | Prevent system sleep while the agent runs.                                                                                |
| `tool-display-mode` | `ctrl+o`             | Cycle tool output modes and combine background activity in the composer.                                                  |
| `ghostty`           | —                    | Ghostty tab title enhancements while the agent is working, waiting, or idle.                                              |
| `git-diff-stats`    | —                    | Status bar diff stats for local changes in the current repo.                                                              |
| `git-pr-status`     | —                    | Status bar PR number and link for the current branch.                                                                     |
| `insights`          | `/insights`          | Analyze Pi sessions and suggest reusable instructions, templates, skills, and extensions.                                 |
| `stash`             | `alt+x`              | Stash the current message draft, send one message, then restore it.                                                       |
| `loop`              | `/loop`              | Repeat a prompt until the agent signals success.                                                                          |
| `notify`            | —                    | Terminal notification when the agent is waiting for input.                                                                |
| `fast`              | `/fast`              | Toggle fast processing for compatible models.                                                                             |
| `openai-verbosity`  | `/verbosity`         | Set verbosity for supported OpenAI models.                                                                                |
| `review`            | `/review`, `/triage` | Multi-focus review and PR feedback triage for PRs, branches, commits, and local changes, with integrated follow-up fixes. |
| `sandbox`           | `/sandbox`           | OS-level bash sandboxing plus filesystem guardrails for native Pi file tools.                                             |
| `telegram`          | `/telegram`          | Interact with Pi via a Telegram bot, mirror output, and send files from local sessions.                                   |
| `subagent`          | —                    | Delegate work to background Pi agents and follow up with them.                                                            |
| `usage`             | `/usage`             | Historical provider usage breakdown with all-provider history and live quota snapshots.                                   |
| `websearch`         | —                    | Web search via Gemini, OpenAI, or Claude, leveraging Pi or browser session credentials.                                   |
| `worktree`          | `/worktree`          | Create, list, and archive git worktrees, optionally opening them in a new terminal or tmux pane.                          |

## Skills

| Skill                 | Description                                                                        |
| --------------------- | ---------------------------------------------------------------------------------- |
| `browser-tools`       | Interactive browser automation via Chrome DevTools Protocol.                       |
| `git-clean-history`   | Reimplement a branch on a fresh branch off `main` with a clean commit history.     |
| `git-commit`          | Tidy, focused commits with clear rationale in messages.                            |
| `github-pull-request` | Create and steward pull requests through CI, review, and merge.                    |
| `oracle`              | Second opinion from another LLM for debugging, refactors, design, or code reviews. |
| `sentry`              | Fetch and analyze Sentry issues, events, transactions, and logs.                   |
| `update-changelog`    | Update CHANGELOG.md following Keep a Changelog.                                    |
| `web-design`          | Distinctive, production-ready web interfaces.                                      |
| `homeassistant-ops`   | Operate a Home Assistant instance via REST/WebSocket APIs.                         |
| `openscad`            | Create and render OpenSCAD 3D models, export STL.                                  |

## Themes

| Theme      | Description                                                   |
| ---------- | ------------------------------------------------------------- |
| `tau-dark` | Pi's official dark theme with a calmer, more cohesive polish. |

## Git over SSH on macOS

Tau routes Git-over-SSH connections through the sandbox's authenticated proxy. Private-key files remain blocked, so load the key into the macOS SSH agent from a trusted terminal with `ssh-add --apple-use-keychain ~/.ssh/id_ed25519`. Configure the host with `IdentityFile ~/.ssh/id_ed25519.pub` and `IdentitiesOnly yes`; the public key selects the matching agent identity but cannot authenticate by itself.

Use `ssh-add -l` to confirm that the identity is loaded. After a macOS logout or restart, restore Keychain-backed identities from a trusted login context with `ssh-add --apple-load-keychain`. A user LaunchAgent can run that command at login. While loaded, the key is available for signing through `$SSH_AUTH_SOCK` to sandboxed processes.

## Agent configuration

Tau does not include agent configuration; those files are highly personal. Configure Pi with your own `AGENTS.md`, `settings.json`, sandbox config, and model preferences.
