# acp-client

Use Claude and Codex agents from Pi over the [Agent Client Protocol](https://agentclientprotocol.com).

Pi acts as the ACP client: it spawns an agent adapter as a subprocess, speaks JSON-RPC over stdio, streams the agent's progress (messages, thoughts, tool calls, plans), and surfaces the agent's permission requests as interactive prompts.

## What you get

- **`acp_agent` tool** — Pi's model can delegate tasks to Claude or Codex subagents. Each call returns the agent's final answer plus a session ID the model can pass back to continue the conversation.
- **`/acp` command** — drive an agent directly. Replies are recorded in the session as custom messages, so they become part of Pi's context.

```
/acp claude refactor the parser to be iterative
/acp codex why does the build fail on node 24?
/acp new claude start over with a clean slate
/acp view claude follow the live transcript
/acp stop
```

Conversations persist per agent across `/acp` invocations until you use `new`, `stop`, or the Pi session ends.

## Viewing a running session

`/acp` prompts run in the background with a one-line status in the footer. To watch the full transcript as it streams — messages, thoughts, tool calls, and plans — open `/acp view` (or `/acp view <agent>` to skip the picker). The viewer tails to the bottom as updates arrive unless you scroll up, and stays open after the turn completes so you can read the final answer. Close it with `Enter` or `Esc`.

## Agents

| Agent    | Adapter                                                                                                        | Auth                                   |
| -------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `claude` | [`@agentclientprotocol/claude-agent-acp`](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp) | `claude /login` or `ANTHROPIC_API_KEY` |
| `codex`  | [`@zed-industries/codex-acp`](https://www.npmjs.com/package/@zed-industries/codex-acp)                         | `codex login` or `OPENAI_API_KEY`      |

Adapters are launched lazily via `npx -y` and reused for the lifetime of the Pi session. The first launch downloads the adapter into the npx cache.

## Permissions

When an agent asks permission to run a command or edit a file, the request appears as a Pi selector with the agent's own options (allow once, always, reject, ...). Without UI (print/RPC mode), requests are automatically rejected.

The agent reads and writes files through Pi (`fs/read_text_file`, `fs/write_text_file`), scoped to the session's working directory by the adapter.

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
