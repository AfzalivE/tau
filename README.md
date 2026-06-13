# Tau

Tau is a batteries-included distribution for [Pi](https://pi.dev), a brilliant coding agent by @badlogic that's barebones yet highly (and elegantly) extensible by design.

It takes Pi's minimal core and turns it into an opinionated, complete, polished experience, adding a `websearch` tool to complement the four default built-in tools, plus several useful skills and tasteful extensions, split into purpose-driven packages:

| Package               | Purpose                                                |
| --------------------- | ------------------------------------------------------ |
| `tau-coding-agent`    | Coding package.                                                     |
| `tau-all-agent`       | Full package.                                                       |
| `afzal-tau-all-agent` | Full fork-specific package except the `memory` extension.           |

Fork-specific package/configuration details are grouped under [Fork-specific additions](#fork-specific-additions) below.

## Install

[Install Pi](https://pi.dev/docs/latest#quick-start), and then:

```bash
pi install npm:tau-coding-agent
# or
pi install npm:tau-all-agent
# or
pi install npm:afzal-tau-all-agent
```

Need the full fork-specific package? `afzal-tau-all-agent` bundles the base Tau package contents plus the fork-specific extensions and skills listed below, but intentionally excludes the `memory` extension.

Project-local install allows you to pin Tau for everyone working on the project:

```bash
pi install -l npm:tau-coding-agent
```

## Extensions

| Extension           | Command              | Coding | All | Description                                                                                                               |
| ------------------- | -------------------- | :----: | :-: | ------------------------------------------------------------------------------------------------------------------------- |
| `acp-client`        | `/acp`               |   ✓    |  ✓  | Use Claude and Codex agents via the Agent Client Protocol.                                                                |
| `answer`            | `/answer`            |   ✓    |  ✓  | Extract and interactively answer agent questions.                                                                         |
| `branch-term`       | `/branch`            |   ✓    |  ✓  | Open a new terminal on the current session's git branch.                                                                  |
| `btw`               | `/btw`               |   ✓    |  ✓  | Run a one-off side request with read-only tools and no context persistence.                                               |
| `ghostty`           | —                    |   ✓    |  ✓  | Ghostty tab title enhancements while the agent is working, waiting, or idle.                                              |
| `git-diff-stats`    | —                    |   ✓    |  ✓  | Status bar diff stats for local changes in the current repo.                                                              |
| `git-pr-status`     | —                    |   ✓    |  ✓  | Status bar PR number and link for the current branch.                                                                     |
| `insights`          | `/insights`          |   ✓    |  ✓  | Analyze Pi sessions and suggest reusable instructions, templates, skills, and extensions.                                 |
| `interlude`         | `alt+x`              |   ✓    |  ✓  | Stash the current message draft, send one interlude message, then restore the draft.                                      |
| `loop`              | `/loop`              |   ✓    |  ✓  | Repeat a prompt until the agent signals success.                                                                          |
| `memory`            | `/memory`            |   ✓    |  ✓  | Opt-in project-local memory for learning and continuity across sessions.                                                  |
| `notify`            | —                    |   ✓    |  ✓  | Terminal notification when the agent is waiting for input.                                                                |
| `openai-fast`       | `/fast`              |   ✓    |  ✓  | Toggle priority service tier for supported OpenAI models.                                                                 |
| `openai-verbosity`  | `/verbosity`         |   ✓    |  ✓  | Set verbosity for supported OpenAI models.                                                                                |
| `review`            | `/review`, `/triage` |   ✓    |  ✓  | Multi-focus review and PR feedback triage for PRs, branches, commits, and local changes, with integrated follow-up fixes. |
| `sandbox`           | `/sandbox`           |   ✓    |  ✓  | OS-level sandboxing for bash commands with runtime overrides.                                                             |
| `tool-display-mode` | `ctrl+o`             |   ✓    |  ✓  | Cycle tool output between Pi's default rendering, expanded output, and compact summaries.                                 |
| `usage`             | `/usage`             |   ✓    |  ✓  | Historical provider usage breakdown with all-provider history and live quota snapshots.                                   |
| `websearch`         | —                    |   ✓    |  ✓  | Web search via Gemini, OpenAI, or Claude, leveraging Pi or browser session credentials.                                   |
| `worktree`          | `/worktree`          |   ✓    |  ✓  | Create, list, and archive git worktrees, optionally opening them in a new terminal or tmux pane.                          |
| `telegram`          | `/telegram`          |   —    |  ✓  | Interact with Pi via a Telegram bot and local daemon.                                                                     |
| `todoist`           | `/todoist`           |   —    |  —  | Todoist-backed tasks with offline outbox sync for single or multi-session work.                                           |

## Skills

| Skill               | Coding | All | Description                                                                        |
| ------------------- | :----: | :-: | ---------------------------------------------------------------------------------- |
| `browser-tools`     |   ✓    |  ✓  | Interactive browser automation via Chrome DevTools Protocol.                       |
| `git-clean-history` |   ✓    |  ✓  | Reimplement a branch on a fresh branch off `main` with a clean commit history.     |
| `git-commit`        |   ✓    |  ✓  | Tidy, focused commits with clear rationale in messages.                            |
| `oracle`            |   ✓    |  ✓  | Second opinion from another LLM for debugging, refactors, design, or code reviews. |
| `sentry`            |   ✓    |  ✓  | Fetch and analyze Sentry issues, events, transactions, and logs.                   |
| `update-changelog`  |   ✓    |  ✓  | Update CHANGELOG.md following Keep a Changelog.                                    |
| `web-design`        |   ✓    |  ✓  | Distinctive, production-ready web interfaces.                                      |
| `homeassistant-ops` |   —    |  ✓  | Operate a Home Assistant instance via REST/WebSocket APIs.                         |
| `openscad`          |   —    |  ✓  | Create and render OpenSCAD 3D models, export STL.                                  |

## Themes

| Theme      | Coding | All | Description                                                   |
| ---------- | :----: | :-: | ------------------------------------------------------------- |
| `tau-dark` |   ✓    |  ✓  | Pi's official dark theme with a calmer, more cohesive polish. |

## Development

```bash
npm install
npm run check

pi -e ./packages/tau-coding-agent
pi -e ./packages/tau-all-agent
pi -e ./packages/afzal-tau-all-agent
```

The source package manifests reference local resources so `pi -e ./packages/...` works from this checkout. `npm run package` stages self-contained publishable packages under `dist/`.

## Publishing

All publishable packages share the same version. Release tags use the plain version number, for example `0.1.0`.

The GitHub Actions publish workflow stages packages under `dist/` and publishes in this order:

1. `tau-coding-agent`
2. `tau-all-agent`
3. `afzal-tau-all-agent`

Published packages are self-contained copies of their selected Tau resources.

## Fork-specific additions

This fork keeps Afzal-specific packaging, personal setup helpers, and extra resources separate from the original Tau package documentation above.

### Package

`afzal-tau-all-agent` bundles the base Tau package contents plus the fork-specific extensions and skills listed below, but intentionally excludes the `memory` extension.

Install it with:

```bash
pi install npm:afzal-tau-all-agent
```

For local development/testing:

```bash
pi -e ./packages/afzal-tau-all-agent
```

When publishing this fork, `afzal-tau-all-agent` is published after `tau-coding-agent` and `tau-all-agent`.

### Agent configuration

Tau does not include agent configuration; those files are highly personal.

Check out [AfzalivE/.agents](https://github.com/AfzalivE/.agents) for my `AGENTS.md`, `settings.json`, `sandbox.json`, etc.

If you keep a separate personal agent-config repo, set up Tau-managed Codex and Claude links from the Tau checkout root with:

```bash
./bin/setup
```

That keeps the personal agent-config skills directory pointed at this checkout's `skills/` directory, links the personal `AGENTS.md` into Codex and Claude, and populates Claude's local skills directory with Tau skill symlinks.

Nightly vault maintenance also lives here:

```bash
./bin/dream [--dry-run]
```

That wrapper reads dream config from the personal agent-config repo via `AGENTS_DIR`, runs the bundled `dream` skill helpers from this repo, and targets the configured agent-brain vault by default. Set `AGENT_BRAIN_DIR` to override the vault path.

### Extensions in this fork

Bundled in `afzal-tau-all-agent`.

| Extension         | Command      | Description                                                              |
| ----------------- | ------------ | ------------------------------------------------------------------------ |
| `converge`        | `/converge`  | Run multiple planner personas and synthesize one recommended plan.       |
| `spotlight`       | `/spotlight` | Mirror a linked worktree into the main worktree while you work elsewhere. |
| `todoist`         | `/todoist`   | Todoist-backed tasks with offline outbox sync for single or multi-session work. |

### Skills in this fork

Bundled in `afzal-tau-all-agent`.

| Skill                           | Description                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| `diagnose`                      | Disciplined diagnosis loop for hard bugs and performance regressions.                       |
| `grill-me`                      | Interview the user relentlessly about a plan or design until reaching shared understanding. |
| `grill-with-docs`               | Stress-test a plan against the project's domain model, terminology, and ADRs.               |
| `handoff`                       | Compact the current conversation into a handoff document for another agent.                 |
| `improve-codebase-architecture` | Find deepening opportunities informed by `CONTEXT.md` and `docs/adr/`.                      |
| `material-3`                    | Implement Google's Material Design 3 UI system, especially Jetpack Compose Material3.       |
| `setup-matt-pocock-skills`      | Scaffold repo config for issue tracker, triage labels, and domain doc layout.               |
| `tdd`                           | Test-driven development with a red-green-refactor loop.                                     |
| `to-issues`                     | Break a plan, spec, or PRD into independently grabbable issues.                             |
| `to-prd`                        | Turn the current conversation context into a PRD and publish it to the issue tracker.       |
| `triage`                        | Triage issues through a state machine driven by triage roles.                               |
| `write-a-skill`                 | Create new agent skills with proper structure and bundled resources.                         |
| `zoom-out`                      | Give broader codebase context and a higher-level perspective for unfamiliar areas.           |
| `cald`                          | Apple Calendar CLI for listing calendars, reading events, and creating events on this Mac.  |
| `daily-agenda`                  | Retrieve the active daily agenda against the current local time.                             |
| `dream`                         | Nightly vault maintenance for consolidating, reorganizing, and weakening stale content.      |
| `gh`                            | GitHub CLI for issues, PRs, Actions, search, and raw API calls.                             |
| `git-rebase-check`              | Verify that a rebased branch preserved the same cumulative patch.                            |
| `git-worktree`                  | Manage git worktrees for multiple branches in separate directories.                          |
| `ms-openapi-explorer`           | Explore Microsoft Graph API v1.0 OpenAPI specs from cached YAML.                            |
| `qmd`                           | Local semantic search engine for markdown knowledge bases.                                   |
| `pup/datadog/dashboards`        | Manage Datadog dashboards through the pup CLI and Datadog API.                               |
| `review-breaker`                | Break a large review branch into a temporary stack of smaller reviewer-friendly commits.     |
| `td`                            | Todoist CLI for task and project management.                                                 |
| `tw`                            | Twist CLI for team messaging, threads, DMs, and search.                                     |

See each `skills/*/SKILL.md` for the exact behavior and usage contract.

## Acknowledgements

Some extensions and skills were inspired by prior work from other agent setups and Pi users:

- [@goncalossilva](https://github.com/goncalossilva) for the original [Tau](https://github.com/goncalossilva/tau) this fork builds on
- @mitsuhiko for `answer`, `btw`, `loop`, `openscad`, `sentry`, `update-changelog`, and `web-design`
- @badlogic for `sandbox` and `browser-tools`
- @mjakl for `interlude`
- [@mattpocock](https://github.com/mattpocock) for `diagnose`, `grill-me`, `grill-with-docs`, `handoff`, `improve-codebase-architecture`, `setup-matt-pocock-skills`, `tdd`, `to-issues`, `to-prd`, `triage`, `write-a-skill`, and `zoom-out`
- [@enricenrich](https://github.com/enricenrich) for [calendar-cli](https://github.com/enricenrich/calendar-cli), which `cald` depends on

## License

Released under the [MIT License](https://opensource.org/licenses/MIT).
