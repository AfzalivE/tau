# Tau

Tau is a batteries-included distribution for [Pi](https://pi.dev), a brilliant coding agent by @badlogic that's barebones yet highly (and elegantly) extensible by design.

It takes Pi's minimal core and turns it into an opinionated, complete, polished experience, adding `websearch` and `subagent` tools to complement the default built-in tools, plus several useful skills and tasteful extensions, split into purpose-driven packages:

| Package                      | Purpose                                                                |
| ---------------------------- | ---------------------------------------------------------------------- |
| `tau-acp-client`             | Standalone ACP client package for Claude and Codex agents.             |
| `tau-coding-agent`           | Coding package.                                                        |
| `tau-all-agent`              | Full package.                                                          |
| `afzal-tau-all-agent`        | Full fork-specific package except the `memory` extension.              |
| `afzal-tau-non-coding-agent` | Local-model knowledge-work package for insights from non-code sources. |

Fork-specific package/configuration details are grouped under [Fork-specific additions](#fork-specific-additions) below.

## Install

[Install Pi](https://pi.dev/docs/latest#quick-start), and then:

```bash
pi install npm:tau-acp-client
# or
pi install npm:tau-coding-agent
# or
pi install npm:tau-all-agent
# or
pi install npm:afzal-tau-all-agent
# or
pi install npm:afzal-tau-non-coding-agent
```

Need the full fork-specific package? `afzal-tau-all-agent` bundles the base Tau package contents plus the fork-specific extensions and skills listed below, but intentionally excludes the `memory` extension.

Project-local install allows you to pin Tau for everyone working on the project:

```bash
pi install -l npm:tau-coding-agent
```

## Extensions

The standalone `tau-acp-client` package provides the `acp-client` extension; the Tau bundle packages below do not include it.

| Extension                                     | Command              | Coding | All | Description                                                                                                               |
| --------------------------------------------- | -------------------- | :----: | :-: | ------------------------------------------------------------------------------------------------------------------------- |
| `answer`                                      | `/answer`            |   ✓    |  ✓  | Extract and interactively answer agent questions.                                                                         |
| `branch-term`                                 | `/branch`            |   ✓    |  ✓  | Fork the selected Pi conversation for a separate terminal or tmux pane.                                                   |
| `btw`                                         | `/btw`               |   ✓    |  ✓  | Run a one-off side request with read-only tools and no context persistence.                                               |
| `caffeinate`                                  | —                    |   ✓    |  ✓  | Prevent system sleep while the agent runs.                                                                                |
| `ghostty`                                     | —                    |   ✓    |  ✓  | Ghostty tab title enhancements while the agent is working, waiting, or idle.                                              |
| `git-diff-stats`                              | —                    |   ✓    |  ✓  | Status bar diff stats for local changes in the current repo.                                                              |
| `git-pr-status`                               | —                    |   ✓    |  ✓  | Status bar PR number and link for the current branch.                                                                     |
| `insights`                                    | `/insights`          |   ✓    |  ✓  | Analyze Pi sessions and suggest reusable instructions, templates, skills, and extensions.                                 |
| `stash`                                       | `alt+x`              |   ✓    |  ✓  | Stash the current message draft, send one message, then restore it.                                                       |
| `loop`                                        | `/loop`              |   ✓    |  ✓  | Repeat a prompt until the agent signals success.                                                                          |
| `memory`                                      | `/memory`            |   ✓    |  ✓  | Opt-in project-local memory for learning and continuity across sessions.                                                  |
| `notify`                                      | —                    |   ✓    |  ✓  | Terminal notification when the agent is waiting for input.                                                                |
| `fast`                                        | `/fast`              |   ✓    |  ✓  | Toggle fast processing for compatible models.                                                                             |
| `openai-verbosity`                            | `/verbosity`         |   ✓    |  ✓  | Set verbosity for supported GPT models.                                                                                   |
| [`review`](extensions/review/README.md)       | `/review`, `/triage` |   ✓    |  ✓  | Multi-focus review and PR feedback triage for PRs, branches, commits, and local changes, with integrated follow-up fixes. |
| [`sandbox`](extensions/sandbox/README.md)     | `/sandbox`           |   ✓    |  ✓  | OS-level sandboxing with runtime overrides and opt-in classifier approval.                                                |
| `subagent`                                    | —                    |   ✓    |  ✓  | Delegate work to background Pi agents, with configurable model and thinking recommendations.                              |
| `tool-display-mode`                           | `ctrl+o`             |   ✓    |  ✓  | Cycle tool output modes and combine background activity in the composer.                                                  |
| [`usage`](extensions/usage/README.md)         | `/usage`             |   ✓    |  ✓  | Historical provider usage breakdown with all-provider history and live quota snapshots.                                   |
| [`websearch`](extensions/websearch/README.md) | —                    |   ✓    |  ✓  | Web search via Gemini, OpenAI, or Claude, leveraging Pi or browser session credentials.                                   |
| `worktree`                                    | `/worktree`          |   ✓    |  ✓  | Create, list, and archive git worktrees, optionally opening them in a new terminal or tmux pane.                          |
| [`telegram`](extensions/telegram/README.md)   | `/telegram`          |   —    |  ✓  | Interact with Pi via a Telegram bot and local daemon.                                                                     |

Tool Display Mode applies to `read`, `bash`, `grep`, `find`, and `ls`, including extension-provided replacements. It changes rendering only. Execution and approval requirements are unchanged.

While Review or Subagent work is active, **Esc** asks **“Cancel all ongoing work?”**. **Enter** confirms cancellation. **Esc** again or **No** keeps the work running. One confirmation covers both extensions and the parent agent. Session cleanup remains unconditional.

After confirmed cancellation, Review retains queued text and images for your next message instead of restarting the agent automatically.

### Git over SSH in the macOS sandbox

Tau routes Git-over-SSH connections through sandbox-runtime's authenticated proxy on macOS. The default policy exposes `$SSH_AUTH_SOCK` and permits SSH configuration, known hosts, and public keys while private-key files stay blocked. Use an SSH agent instead of granting the sandbox access to a private key.

In a trusted terminal outside Pi, save the key's passphrase in Keychain and load the key into the macOS agent:

```bash
ssh-add --apple-use-keychain ~/.ssh/id_ed25519
```

Configure OpenSSH to select that agent identity through its public key:

```sshconfig
Host github.com
    IdentityFile ~/.ssh/id_ed25519.pub
    IdentitiesOnly yes
    UseKeychain yes
```

The public key only selects a matching agent identity. It cannot authenticate by itself. Use `ssh-add -l` to confirm that the matching identity is loaded. Make the first host connection from a trusted terminal outside Pi if `known_hosts` does not contain the host yet.

A Pi restart does not clear the macOS agent. A macOS logout or restart does. If the passphrase was saved in Keychain, restore Keychain-backed identities from a trusted login context with:

```bash
ssh-add --apple-load-keychain
```

A user LaunchAgent can run this command at login. While a key is loaded, sandboxed processes that can reach `$SSH_AUTH_SOCK` can ask the agent to sign with it.

### Saved sandbox approvals

**Always allow and retry** saves the selected permission in the global `<agent-dir>/sandbox.json` (normally `~/.pi/agent/sandbox.json`). Future Pi sessions use that permission across projects. Other approval choices and `/sandbox` policy commands remain session-only.

Project configuration and `--sandbox-config` keep their existing precedence. If they still block the requested access, the global save is rejected without changing the file or granting access. Save failures also prevent retry. After the file is saved, cancellation or a new deny rule can block retry without removing the saved approval. Explicit network denies and mandatory filesystem protections remain in force. To revoke a saved approval, edit the global sandbox configuration; existing sessions retain their live policy until restarted or reloaded.

Per-command approval to run **outside** the sandbox remains one-time and cannot be saved.

### Sandbox exclusions and audit logs

`commands.excluded` runs matching commands outside the OS sandbox. Disable that execution path while keeping the configured list intact with:

```json
{
  "commands": {
    "exclusionsEnabled": false
  }
}
```

When the sandbox is active and exclusions are disabled, matching commands use the normal sandboxed Bash path.

Tau writes a private JSONL audit log for each Pi session under `~/.pi/agent/logs/sandbox/<session-id>.jsonl`. `/sandbox doctor` and `/sandbox show` print the exact path. The log contains effective policy snapshots, interpreted policy events, and raw violations reported by sandbox-runtime. Raw violations are recorded even when the command handles the denial and exits successfully without an approval prompt.

The log can contain commands and local paths. Tau creates it with mode `0600` inside a `0700` directory on POSIX systems. Runtime coverage depends on sandbox-runtime and the operating system. Violations filtered by `ignoreViolations` are not reported. Linux runtime monitoring currently reports denied writes but cannot report every denied read.

Runtime debug logging is off by default. Use `/sandbox debug on` or `/sandbox debug off` to change it for the session. Toggle values are case-insensitive: `enable`, `enabled`, and `true` also turn logging on; `disable`, `disabled`, and `false` turn it off. `/sandbox doctor` shows captured debug lines with timestamps.

## Skills

| Skill                 | Coding | All | Description                                                                        |
| --------------------- | :----: | :-: | ---------------------------------------------------------------------------------- |
| `browser-tools`       |   ✓    |  ✓  | Interactive browser automation via Chrome DevTools Protocol.                       |
| `git-clean-history`   |   ✓    |  ✓  | Reimplement a branch on a fresh branch off `main` with a clean commit history.     |
| `git-commit`          |   ✓    |  ✓  | Tidy, focused commits with clear rationale in messages.                            |
| `github-pull-request` |   ✓    |  ✓  | Create and steward pull requests through CI, review, and merge.                    |
| `oracle`              |   ✓    |  ✓  | Second opinion from another LLM for debugging, refactors, design, or code reviews. |
| `sentry`              |   ✓    |  ✓  | Fetch and analyze Sentry issues, events, transactions, and logs.                   |
| `update-changelog`    |   ✓    |  ✓  | Update CHANGELOG.md following Keep a Changelog.                                    |
| `web-design`          |   ✓    |  ✓  | Distinctive, production-ready web interfaces.                                      |
| `homeassistant-ops`   |   —    |  ✓  | Operate a Home Assistant instance via REST/WebSocket APIs.                         |
| `openscad`            |   —    |  ✓  | Create and render OpenSCAD 3D models, export STL.                                  |

## Themes

| Theme      | Coding | All | Description                                                   |
| ---------- | :----: | :-: | ------------------------------------------------------------- |
| `tau-dark` |   ✓    |  ✓  | Pi's official dark theme with a calmer, more cohesive polish. |

## Development

```bash
npm install
npm run check

pi -e ./packages/tau-acp-client
pi -e ./packages/tau-coding-agent
pi -e ./packages/tau-all-agent
pi -e ./packages/afzal-tau-all-agent
pi -e ./packages/afzal-tau-non-coding-agent
```

The source package manifests reference local resources so `pi -e ./packages/...` works from this checkout. Installation applies [version-pinned sandbox runtime patches](patches/README.md), using Git. `npm run package` stages self-contained publishable packages under `dist/`, including private copies of the patched runtime.

Run `npm test` for all extension tests or `npm test -- <extension>` for one extension. Node test options can follow the extension name, for example `npm test -- <extension> --test-name-pattern=reload`. TypeScript tests compile into disposable build output. The runner also includes the fork's `.test.mjs` suites in `extensions/`, `scripts/`, and `skills/`. Tests run with isolated home/config directories and no inherited credentials. See [AGENTS.md](AGENTS.md) for extension development and testing guidelines.

CI runs formatting, linting, compilation, extension tests, and package checks on macOS and Linux for pull requests and pushes to `main`.

## Publishing

All publishable packages share the same version. Release tags use the plain version number, for example `0.1.0`.

The GitHub Actions publish workflow stages packages under `dist/` and publishes in this order:

1. `tau-acp-client`
2. `tau-coding-agent`
3. `tau-all-agent`
4. `afzal-tau-all-agent`
5. `afzal-tau-non-coding-agent`

Published packages contain their selected Tau resources and the patched sandbox runtime. Consumers do not need to run patch scripts.

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

### Non-coding agent package

`afzal-tau-non-coding-agent` is a knowledge-work profile for using Pi with non-code sources, such as a personal Obsidian vault, and then running `/insights` over those sessions. It is intended for locally hosted models and bundles the same extensions as `afzal-tau-all-agent`, with only the focused `browser-tools` skill.

Install it with:

```bash
pi install npm:afzal-tau-non-coding-agent
```

For local development/testing:

```bash
pi -e ./packages/afzal-tau-non-coding-agent
```

Configure a local provider such as Ollama, LM Studio, or vLLM in `~/.pi/agent/models.json`, select it with `/model`, and run `/insights scope=project` from the source root. The package does not bundle model configuration.

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

To select a model for the Pi runner, set `pi_model` in `${AGENTS_DIR:-$HOME/.agents}/config/dream.yaml`:

```yaml
runner: pi
pi_model: openai-codex/gpt-6-astra:high
```

The value is passed directly to Pi’s `--model` option. It supports `provider/model` and an optional `:thinking` suffix. Omit `pi_model`, set it to `null`, or leave it empty to use Pi defaults. The Claude runner ignores this setting.

### Extensions in this fork

Bundled in `afzal-tau-all-agent`.

| Extension    | Command         | Description                                                                |
| ------------ | --------------- | -------------------------------------------------------------------------- |
| `code-links` | `/code-links`   | Open file paths and code symbols from the transcript in your editor.       |
| `converge`   | `/converge`     | Run multiple planner personas and synthesize one recommended plan.         |
| `raw`        | `/raw`, `alt+r` | Open the full active-branch transcript in terminal scrollback for copying. |
| `spotlight`  | `/spotlight`    | Mirror a linked worktree into the main worktree while you work elsewhere.  |

Code Links turns `src/Foo.kt:42`, `Foo.kt`, `Foo.bar()`, and `` `Foo` `` in finished user and assistant messages into terminal hyperlinks. It indexes the Git working tree with [Universal Ctags](https://ctags.io) at session start and updates a file's entries after `edit` or `write`. Bare names in prose and names defined in more than one file stay plain text. Links need a terminal with OSC 8 hyperlink support. `/code-links` chooses `zed` (default), `vscode`, `cursor`, `studio` (Android Studio and other JetBrains IDEs, through `idea://`), or `file`, saved in `code-links.json` in the Pi agent directory.

### Skills in this fork

Bundled in `afzal-tau-all-agent`.

| Skill                    | Description                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `address-pr-comments`    | Address PR feedback through disposition, per-change commits, approval, push, and replies.  |
| `fix-ci`                 | Fix failing CI through triage, focused commits, approval, reruns, and verification.        |
| `material-3`             | Implement Google's Material Design 3 UI system, especially Jetpack Compose Material3.      |
| `cald`                   | Apple Calendar CLI for listing calendars, reading events, and creating events on this Mac. |
| `dream`                  | Nightly vault maintenance for consolidating, reorganizing, and weakening stale content.    |
| `gh`                     | GitHub CLI for issues, PRs, Actions, search, and raw API calls.                            |
| `git-rebase-check`       | Verify that a rebased branch preserved the same cumulative patch.                          |
| `git-worktree`           | Manage git worktrees for multiple branches in separate directories.                        |
| `ms-openapi-explorer`    | Explore Microsoft Graph API v1.0 OpenAPI specs from cached YAML.                           |
| `qmd`                    | Local semantic search engine for markdown knowledge bases.                                 |
| `pup/datadog/dashboards` | Manage Datadog dashboards through the pup CLI and Datadog API.                             |
| `review-breaker`         | Break a large review branch into a temporary stack of smaller reviewer-friendly commits.   |
| `td`                     | Todoist CLI for task and project management.                                               |
| `tdc`                    | Comms CLI for Twist team messaging, threads, DMs, and search.                              |

See each `skills/*/SKILL.md` for the exact behavior and usage contract.

## Acknowledgements

Some extensions and skills were inspired by prior work from other agent setups and Pi users:

- [@goncalossilva](https://github.com/goncalossilva) for the original [Tau](https://github.com/goncalossilva/tau) this fork builds on
- @mitsuhiko for `answer`, `btw`, `loop`, `openscad`, `sentry`, `update-changelog`, and `web-design`
- @badlogic for `sandbox` and `browser-tools`
- @mjakl for `stash`
- [@enricenrich](https://github.com/enricenrich) for [calendar-cli](https://github.com/enricenrich/calendar-cli), which `cald` depends on

## License

Released under the [MIT License](https://opensource.org/licenses/MIT).
