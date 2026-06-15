---
name: tdc
description: "Comms CLI for Todoist Comms team messaging — threads, conversations, messages, comments, search, mentions, reactions, and workspace navigation. Use when reading or responding to Todoist Comms messages."
---

# Comms CLI for Todoist Comms (`tdc`)

Validated against CLI version: `1.6.2`

Use CLI help as the source of truth when flags conflict with this skill:

```bash
tdc <command> --help
```

## Common flags

- UX: `--no-spinner`, `--progress-jsonl [path]`, `--include-private-channels`, `--accessible`, `--non-interactive`, `--interactive`
- Output on most read commands: `--json`, `--ndjson`, `--full`

Always use `--json` or `--ndjson` for programmatic parsing.

## Quick reference

| Task | Command |
|------|---------|
| Check inbox | `tdc inbox` |
| Unread inbox | `tdc inbox --unread` |
| Unread DMs/groups | `tdc conversation unread` |
| Mentions | `tdc mentions --json` or `tdc search "query" --mention-me` |
| Read a thread | `tdc thread view <ref>` |
| Reply to a thread | `tdc thread reply <ref> "text"` |
| Create a thread | `tdc thread create <channel-ref> "Title" "Body"` |
| Read a DM/group | `tdc conversation view <ref>` |
| Reply in a DM/group | `tdc conversation reply <ref> "text"` |
| Find 1:1 with a user | `tdc conversation with <user-ref>` |
| Search | `tdc search "query"` |
| React / unreact | `tdc react thread <ref> +1` / `tdc unreact thread <ref> +1` |
| View by URL | `tdc view <url>` |

## Workspace and directory

```bash
tdc workspaces
tdc workspace use <ref>
tdc user
tdc users [workspace-ref]
tdc groups list [workspace-ref]
tdc channels [workspace-ref]
```

- `tdc users`: `--workspace <ref>`, `--search <text>`
- `tdc groups`: `list`, `view`, `create`, `rename`, `delete`, `add-user`, `remove-user`
- `tdc channel|channels`: `list`, `create`, `update`, `delete`, `archive`, `unarchive`, `threads`, `members`
- `tdc channels` defaults to active joined channels; widen with `--scope joined|public|discoverable`, `--state active|all|archived`, and `--include-private-channels` for joined private channels.

## Inbox

```bash
tdc inbox [workspace-ref] [options]
```

- `--workspace <ref>`
- `--channel <filter>`
- `--unread`
- `--archive-filter active|archived|all`
- `--since <date>`, `--until <date>`
- `--limit <n>`

## Threads (`tdc thread`)

```bash
tdc thread view [thread-ref]
tdc thread reply <thread-ref> [content]
tdc thread create <channel-ref> <title> [content]
tdc thread done <thread-ref>
tdc thread mark-read [thread-refs...]
tdc thread delete <thread-ref>
tdc thread mute <thread-ref>
tdc thread rename <thread-ref> <title>
tdc thread update <thread-ref> [content]
tdc thread unmute <thread-ref>
```

### Common thread options

- `view`
  - `--comment <id>`, `--unread`, `--context <n>`
  - `--limit <n>`, `--since <date>`, `--until <date>`, `--raw`
- `reply`
  - `--notify <recipients>` (`EVERYONE`, `EVERYONE_IN_THREAD`, or comma-separated user IDs)
  - `--close`, `--reopen`, `--file <path>`, `--dry-run`, `--json`, `--full`
  - accepts content from stdin
- `create`
  - `--notify <comma-separated-user-ids>`, `--unarchive`, `--no-unarchive`, `--file <path>`, `--dry-run`, `--json`, `--full`
  - accepts content from stdin
- Mutating ops generally support `--dry-run` where relevant; `delete` requires explicit confirmation flags when available.

## Conversations (`tdc conversation` / `tdc convo`)

```bash
tdc conversation unread [workspace-ref]
tdc conversation view [conversation-ref]
tdc conversation with <user-ref> [workspace-ref]
tdc conversation reply <conversation-ref> [content]
tdc conversation done <conversation-ref>
tdc conversation mute <conversation-ref>
tdc conversation unmute <conversation-ref>
```

- `unread`: supports `--workspace <ref>`
- `view`: `--limit <n>`, `--since <date>`, `--until <date>`, `--raw`
- `with`: `--workspace <ref>`, `--include-groups`, `--snippet`
- `reply`: supports stdin, `--file <path>`, `--dry-run`, `--json`, `--full`
- `done`, `mute`, `unmute`: mutating ops with `--dry-run`; `mute` also supports `--minutes <n>`

## Messages and comments

```bash
tdc msg view [message-ref]
tdc msg update <message-ref> [content]
tdc msg delete <message-ref>

tdc comment view [comment-ref]
tdc comment update <comment-ref> [content]
tdc comment delete <comment-ref>
```

- `msg` is for conversation messages.
- `comment` is for thread comments.
- `view`: `--raw`, plus JSON output flags where supported.
- `update`: accepts content arg or stdin, plus `--dry-run`, `--json`, `--full`.
- `delete`: supports `--dry-run` and JSON output where available.

## Search, mentions, and reactions

```bash
tdc search <query> [workspace-ref] [options]
tdc mentions [workspace-ref] [options]
tdc react <target-type> <target-ref> <emoji>
tdc unreact <target-type> <target-ref> <emoji>
```

### Search and mention filters

- `--workspace <ref>`
- `--channel <channel-refs>`
- `--author <user-refs>`
- `--to <user-refs>`
- `--type threads|messages|all`
- `--title-only` (`search` only)
- `--conversation <refs>`
- `--mention-me` (`search` only; `mentions` implies current-user mentions)
- `--since <date>`, `--until <date>`
- `--limit <n>`, `--cursor <cursor>`, `--all`

### Reactions

- `react` / `unreact` target types: `thread`, `comment`, `message`
- Supports `--dry-run` and `--json`

## Auth, account, config, and updates

```bash
tdc auth login|token|status|logout
tdc account list|current|use|remove
tdc config view|set
tdc view <url>
tdc doctor [--json] [--offline]
tdc update [--check|--channel]
tdc update switch
tdc changelog
tdc skill list|install|update|uninstall
tdc completion install|uninstall
```

## Tips

- Joined private channels only show up when you pass `--include-private-channels`.
- `tdc conversation` is the DM/group workflow; `tdc msg` and `tdc comment` are single-entity operations.
- Many mutating commands support `--dry-run`; use it when available.
- If `tdc` reports `AUTH_REFRESH_EXPIRED`, rerun `tdc auth login`.
- Refs are usually Todoist IDs or Todoist Comms URLs.
- Date filters use ISO format like `2026-04-23`.
