# double-tau

Afzal's own extensions and skills for [Pi](https://pi.dev), separate from the [Tau](https://github.com/goncalossilva/tau) fork they live in.

## Install

```bash
pi install npm:double-tau
```

Project-local install lets a repository pin these extensions and skills for everyone working on it:

```bash
pi install -l npm:double-tau
```

Install it alone or next to a Tau package such as `afzal-tau-all-agent`.

## Extensions

| Extension    | Command         | Description                                                                                       |
| ------------ | --------------- | ------------------------------------------------------------------------------------------------- |
| `acp-client` | `/acp`          | Use Claude and Codex agents over the Agent Client Protocol, from the TUI or the `acp_agent` tool. |
| `code-links` | `/code-links`   | Make file paths and code symbols in the transcript open in your editor. Requires Universal Ctags. |
| `converge`   | `/converge`     | Run multiple planner personas and synthesize one recommended plan.                                |
| `raw`        | `/raw`, `alt+r` | Open the full active-branch transcript in terminal scrollback for copying.                        |
| `spotlight`  | `/spotlight`    | Mirror a linked worktree into the main worktree while you work elsewhere.                         |

## Skills

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

## ACP client

The `acp-client` extension connects Pi to Claude and Codex agents over the [Agent Client Protocol](https://agentclientprotocol.com) via:

- the `acp_agent` tool, which lets Pi delegate to Claude or Codex subagents; and
- the `/acp` command, which lets you drive ACP agents directly from the TUI.

### Usage

```text
/acp claude refactor the parser to be iterative
/acp codex why does the build fail on node 24?
/acp view codex-1
/acp stop codex-1
/acp stop
```

See `extensions/acp-client/README.md` in the package for full command, session, viewer, permission, and configuration details.

### Configuration

Optional, at `~/.pi/acp.json`:

```json
{
  "agents": {
    "claude": {
      "env": { "ANTHROPIC_API_KEY": "..." }
    },
    "codex": {
      "command": "/path/to/custom/codex-acp",
      "args": []
    }
  }
}
```

Both adapters are installed with this package and launched from their installed entry points. `command`/`args` replace that default launch; `env` is merged over the inherited environment. An `env`-only override keeps the installed adapter default.
