# afzal-tau-all-agent

Full fork-specific Tau package for [Pi](https://pi.dev).

This package bundles every extension except `memory`, every skill in this repo, plus the `tau-dark` theme.

## Install

```bash
pi install npm:afzal-tau-all-agent
```

Project-local install lets a repository pin the full fork package for everyone working on it:

```bash
pi install -l npm:afzal-tau-all-agent
```

## Extensions

| Extension          | Command              | Description                                                                                                               |
| ------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `answer`           | `/answer`            | Extract and interactively answer agent questions.                                                                         |
| `branch-term`      | `/branch`            | Open a new terminal on the current session's git branch.                                                                  |
| `btw`              | `/btw`               | Run a one-off side request with read-only tools and no context persistence.                                               |
| `tool-display-mode` | `ctrl+o`             | Cycle tool output between Pi's default rendering, expanded output, and compact summaries.                                |
| `converge`         | `/converge`          | Run multiple planner personas and synthesize one recommended plan.                                                        |
| `ghostty`          | —                    | Ghostty tab title enhancements while the agent is working, waiting, or idle.                                              |
| `git-diff-stats`   | —                    | Status bar diff stats for local changes in the current repo.                                                              |
| `git-pr-status`    | —                    | Status bar PR number and link for the current branch.                                                                     |
| `insights`         | `/insights`          | Analyze Pi sessions and suggest reusable instructions, templates, skills, and extensions.                                 |
| `interlude`        | `alt+x`              | Stash the current message draft, send one interlude message, then restore the draft.                                      |
| `loop`             | `/loop`              | Repeat a prompt until the agent signals success.                                                                          |
| `notify`           | —                    | Terminal notification when the agent is waiting for input.                                                                |
| `openai-fast`      | `/fast`              | Toggle priority service tier for supported OpenAI models.                                                                 |
| `openai-verbosity` | `/verbosity`         | Set verbosity for supported OpenAI models.                                                                                |
| `review`           | `/review`, `/triage` | Multi-focus review and PR feedback triage for PRs, branches, commits, and local changes, with integrated follow-up fixes. |
| `sandbox`          | `/sandbox`           | OS-level sandboxing for bash commands with runtime overrides.                                                             |
| `spotlight`        | `/spotlight`         | Mirror a linked worktree into the main worktree while you work elsewhere.                                                 |
| `telegram`         | `/telegram`          | Interact with Pi via a Telegram bot and local daemon.                                                                     |
| `todoist`          | `/todoist`           | Todoist-backed tasks with offline outbox sync for single or multi-session work.                                           |
| `usage`            | `/usage`             | Historical provider usage breakdown with all-provider history and live quota snapshots.                                   |
| `websearch`        | —                    | Web search via Gemini, OpenAI, or Claude, leveraging Pi or browser session credentials.                                   |
| `worktree`         | `/worktree`          | Create, list, and archive git worktrees, optionally opening them in a new terminal or tmux pane.                          |

## Skills

| Skill                           | Description                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| `browser-tools`                | Interactive browser automation via Chrome DevTools Protocol.                                |
| `git-clean-history`            | Reimplement a branch on a fresh branch off `main` with a clean commit history.              |
| `git-commit`                   | Tidy, focused commits with clear rationale in messages.                                     |
| `oracle`                       | Second opinion from another LLM for debugging, refactors, design, or code reviews.          |
| `sentry`                       | Fetch and analyze Sentry issues, events, transactions, and logs.                            |
| `update-changelog`             | Update CHANGELOG.md following Keep a Changelog.                                             |
| `web-design`                   | Distinctive, production-ready web interfaces.                                               |
| `homeassistant-ops`            | Operate a Home Assistant instance via REST/WebSocket APIs.                                  |
| `openscad`                     | Create and render OpenSCAD 3D models, export STL.                                           |
| `diagnose`                     | Disciplined diagnosis loop for hard bugs and performance regressions.                        |
| `grill-me`                     | Interview the user relentlessly about a plan or design until reaching shared understanding.  |
| `grill-with-docs`              | Stress-test a plan against the project's domain model, terminology, and ADRs.                |
| `improve-codebase-architecture`| Find deepening opportunities informed by `CONTEXT.md` and `docs/adr/`.                       |
| `setup-matt-pocock-skills`     | Scaffold repo config for issue tracker, triage labels, and domain doc layout.                |
| `tdd`                          | Test-driven development with a red-green-refactor loop.                                      |
| `to-issues`                    | Break a plan, spec, or PRD into independently grabbable issues.                              |
| `to-prd`                       | Turn the current conversation context into a PRD and publish it to the issue tracker.        |
| `triage`                       | Triage issues through a state machine driven by triage roles.                                |
| `write-a-skill`                | Create new agent skills with proper structure and bundled resources.                          |
| `zoom-out`                     | Give broader codebase context and a higher-level perspective for unfamiliar areas.            |
| `cald`                         | Apple Calendar CLI for listing calendars, reading events, and creating events on this Mac.   |
| `daily-agenda`                 | Retrieve the active daily agenda against the current local time.                              |
| `dream`                        | Nightly vault maintenance for consolidating, reorganizing, and weakening stale content.       |
| `gh`                           | GitHub CLI for issues, PRs, Actions, search, and raw API calls.                              |
| `git-rebase-check`             | Verify that a rebased branch preserved the same cumulative patch.                             |
| `git-worktree`                 | Manage git worktrees for multiple branches in separate directories.                           |
| `ms-openapi-explorer`          | Explore Microsoft Graph API v1.0 OpenAPI specs from cached YAML.                             |
| `qmd`                          | Local semantic search engine for markdown knowledge bases.                                    |
| `review-breaker`               | Break a large review branch into a temporary stack of smaller reviewer-friendly commits.      |
| `td`                           | Todoist CLI for task and project management.                                                  |
| `tw`                           | Twist CLI for team messaging, threads, DMs, and search.                                      |

## Themes

| Theme      | Description                                                   |
| ---------- | ------------------------------------------------------------- |
| `tau-dark` | Pi's official dark theme with a calmer, more cohesive polish. |

## Agent configuration

Tau does not include agent configuration; those files are highly personal. Configure Pi with your own `AGENTS.md`, `settings.json`, sandbox config, and model preferences.
