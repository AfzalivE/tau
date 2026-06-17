# tau-acp-client

Standalone ACP client package for [Pi](https://pi.dev).

Use Claude and Codex agents from Pi over the [Agent Client Protocol](https://agentclientprotocol.com) via:

- the `acp_agent` tool, which lets Pi delegate to Claude or Codex subagents; and
- the `/acp` command, which lets you drive ACP agents directly from the TUI.

## Install

```bash
pi install npm:tau-acp-client
```

Project-local install lets a repository pin the ACP client for everyone working on it:

```bash
pi install -l npm:tau-acp-client
```

Install this standalone package when you want ACP without the rest of Tau.

## Usage

```text
/acp claude refactor the parser to be iterative
/acp codex why does the build fail on node 24?
/acp view codex-1
/acp stop codex-1
/acp stop
```

See `extensions/acp-client/README.md` in the package for full command, session, viewer, permission, and configuration details.

## Configuration

Optional, at `~/.pi/acp.json`:

```json
{
  "agents": {
    "claude": {
      "command": "claude-agent-acp",
      "args": [],
      "env": { "ANTHROPIC_API_KEY": "..." }
    },
    "codex": {
      "command": "codex-acp",
      "args": []
    }
  }
}
```

`command`/`args` replace the default `npx` launch; `env` is merged over the inherited environment.
