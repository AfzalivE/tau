# acp-client

Use Claude and Codex agents from Pi over the [Agent Client Protocol](https://agentclientprotocol.com).

Pi acts as the ACP client: it spawns an agent adapter as a subprocess, speaks JSON-RPC over stdio, streams the agent's progress (messages, thoughts, tool calls, plans), and surfaces the agent's permission requests as interactive prompts.

## What you get

- **`acp_agent` tool** — Pi's model can delegate tasks to Claude or Codex subagents. Each call returns the agent's final answer plus a session ID the model can pass back to continue the conversation.
- **`/acp` command** — drive an agent directly. Replies are recorded in the session as custom messages, so they become part of Pi's context.

While `acp_agent` is active, it tells Pi to use ACP only as a capability bridge when a required tool or integration is unavailable in Pi—for example, a Codex Figma plugin. If Pi has suitable tools, Pi should do the work directly. Delegated prompts should still be self-contained, verified, and continued through the same session when appropriate.

## Sessions

Multiple sessions can run at once. Prompting an **agent name** starts a new session and gives it a short handle (`claude-1`, `codex-1`, `claude-2`, …); prompting a **handle** continues that specific session. Each reply shows its handle so you know what to continue.

```
/acp claude refactor the parser to be iterative   # starts claude-1
/acp codex why does the build fail on node 24?     # starts codex-1
/acp claude draft a migration plan                 # starts claude-2, runs alongside claude-1
/acp claude-1 now make it tail-recursive           # continues claude-1
/acp view claude-2                                 # follow claude-2's live transcript
/acp stop claude-1                                 # stop one session
/acp stop                                          # stop everything
```

All sessions of one agent kind share a single adapter process, so they run concurrently and independently.

## Viewing a running session

`/acp` prompts run in the background with a one-line status in the footer. To watch the full transcript as it streams — messages, thoughts, tool calls, and plans — open `/acp view`. With more than one session running you get a picker; pass a handle (`/acp view claude-2`) or an agent name (`/acp view codex`) to narrow it. The viewer tails to the bottom as updates arrive unless you scroll up, and stays open after the turn completes so you can read the final answer. Close it with `Enter` or `Esc`.

While viewing a running session, press `s` to stop it; the footer asks to confirm (`y`/`n`) before cancelling the turn. The stop key only appears for `/acp` sessions you started, not for `acp_agent` tool runs the model drives.

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
