# Fork changelog

All notable fork-specific changes to this project will be documented in this file. Upstream Tau changes stay in [CHANGELOG.md](CHANGELOG.md), which mirrors [goncalossilva/tau](https://github.com/goncalossilva/tau).

The format is based on [Keep a Changelog 2.0.0](https://keepachangelog.com/en/2.0.0/). Fork release tags use `<fork version>-<upstream version>`.

## [Unreleased]

### Added

- Added a `code-links` extension that links file paths and code symbols in the transcript to Zed, VS Code, Cursor, or JetBrains IDEs, using a Universal Ctags index.
- Added an optional `pi_model` setting to select Dream’s Pi model and thinking level without changing Pi defaults.
- Added “Always allow and retry” for global sandbox permissions that persist across Pi sessions, while preserving project overrides.
- Added per-session sandbox audit logs, an exclusion disable switch, and a strict standalone `sandbox-run` command.
- Added the `fix-ci` skill for gated CI diagnosis, focused fixes, approved reruns, and post-push verification.
- Added the `address-pr-comments` skill for gated PR feedback handling with per-change commits and replies.

### Changed

- Documented `gh --attach` uploads for issues and PR/issue comments in the `gh` skill, in addition to PR create and edit.
- Use native dialogs for sandbox filesystem, network, and macOS service approvals instead of the fork's compact permission panels.
- Accepted case-insensitive sandbox debug aliases and included capture timestamps in `/sandbox doctor` diagnostics.

### Security

- Preserved fork command restrictions in background subagents.

### Fixed

- Avoided false macOS shell-not-found errors with a version-pinned sandbox-runtime patch. ([issue #548](https://github.com/anthropics/sandbox-runtime/issues/548), [PR #567](https://github.com/anthropics/sandbox-runtime/pull/567))
- Allowed native file tools to create permitted files through macOS temporary-directory aliases.

## [0.0.3-0.1.6] - 2026-08-13

### Changed

- Synced with upstream Tau 0.1.6.

## [0.0.2-0.1.5] - 2026-08-06

### Added

- Added `afzal-tau-non-coding-agent`, a local-model knowledge-work profile for running `/insights` over sessions rooted in non-code sources such as Obsidian vaults.

### Changed

- Installed the Claude and Codex ACP adapters with `tau-acp-client` instead of downloading them at runtime through `npx`.

### Removed

- Removed the bundled Matt Pocock skills, including `handoff`.

### Security

- Guarded native Pi file tools with the sandbox filesystem policy.

## [0.0.1-0.1.4] - 2026-07-14

### Added

- Added a standalone `tau-acp-client` package for the ACP client extension.
- Added an `acp-client` extension to use Claude and Codex agents via the Agent Client Protocol, through an `acp_agent` tool and an `/acp` command.
- Added a dedicated `/review` security focus.
- Added `/fix loop` to repeat review/fix cycles until the review is clean or progress stops.
- Added Matt Pocock's `handoff` skill to the fork-specific skill bundle.

### Changed

- Restricted model-driven `acp_agent` delegation to tasks requiring capabilities unavailable through Pi's active tools.
- Grounded `/review` efficiency findings in locally provable runtime costs.
- Sharpened `/review` prompts for deslopify-style maintainability issues.
- Updated bundled Matt Pocock skills from the local `mattpocock-skills` checkout.
- Relaxed sandbox defaults for common developer caches and trusted package/source domains, partially aligning with Claude Code on the web defaults.
- Clarified sandbox violation prompts with compact prominent access summaries, targets, and session-only policy changes.

### Fixed

- Fixed the fork-specific package manifest's `review` extension entry so packaging resolves the extension directory.
- Fixed `/sandbox off` still prompting for network access.
