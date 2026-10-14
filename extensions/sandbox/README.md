# Sandbox

Sandboxes Bash commands and their descendants on macOS and Linux, including calls through codemode. Pi itself, other tools, and MCP servers retain host permissions. Run `/sandbox` for help.

Relative filesystem rules and socket paths resolve from the owning session's working directory, including session-only `/sandbox filesystem` changes. Configuration files are not rewritten by permission approvals.

## Classifier fallback

Commands run under the normal sandbox policy first. At a supported permission block, an optional classifier can approve a temporary exception before the usual manual prompt. It must consider the user's intent, the actual permission change, and any side effects already performed by the failed command. There is no blanket approval of commands or automatic escape from the sandbox.

When a classifier is available, the first permission review offers manual approval, classifier setup, or keeping manual approvals. Setup lists credential-available Pi classifiers and, with suitable Codex authentication, `openai-codex/guardian`. Availability does not guarantee endpoint access or remaining quota. Guardian is an experimental Codex Responses adapter returning risk labels, not a probability-producing model registered in Pi's classifier catalog.

Use `/sandbox classifier` to change or disable the reviewer. Choices can be saved for the selected session branch (including reload/resume) or explicitly remembered in the global `sandbox.json`. Session choices take precedence over configuration. `/sandbox show` displays the effective selection.

Configuration follows the usual global, trusted-project, and `--sandbox-config` precedence:

```json
{
  "classifier": "openai-codex/guardian"
}
```

Use a Pi classifier's `provider/model` ID instead to select it. Set `"classifier": false` for manual approvals. Omitting the setting offers setup when a classifier is available. Invalid values fall back to manual approvals.

Reviews send the command (when known), requested permission, failure evidence, and user messages from the selected branch to the selected provider. They can consume quota or incur charges. No tools are available to the reviewer. Missing context, oversized inputs, recognized credential patterns, malformed decisions, uncertainty, and provider errors fall back to manual approval. Native Pi classifiers must report at least 0.95 approval probability and confidence. This is a conservative abstention rule, not a calibrated guarantee of safety; Guardian supplies only its actual risk label. The classifier is a fallible delegated authorizer. Neither genuine denials nor diagnostic claims prove that an exception is necessary, authorized, or safe to replay. The reviewer must justify the proposed capability and replay even assuming the diagnostic was fabricated. These checks do not guarantee that arbitrary command output is free of secrets or prompt injection.

A removed or inaccessible selected model prompts for configuration again. Transient failures retain the selection. Tau never silently switches providers. Non-interactive sessions and subagents retain their existing manual/blocked permission behavior and do not onboard or make classifier approvals independently.

### Approval scope

- **Network:** approval releases only the pending proxy connection. It does not add the host to the session allowlist. The runtime exposes host/port but not trustworthy command identity or request contents. Reviews explicitly describe that missing context rather than attributing the connection to the current command. Explicit network denies and strict allowlists remain enforced by the runtime.
- **Filesystem:** native observations and recognized permission-error output can nominate requests on macOS and Linux. Their provenance is disclosed, including Linux's attacker-controlled syscall telemetry and potentially forged process output. Runtime diagnostics may already be sanitized, so a reported pathname is a candidate, not verified original filename bytes. These inputs never authorize access by themselves. Approval covers the proposed exception **and replay of the entire command**, including possible repeated side effects. A single retry uses its own filesystem policy, applying to that execution and its descendants. Session allowlists and deny rules remain unchanged.
- Some filesystem exceptions are broader than the reported file: removing a write-deny relaxes the whole rule, including applicable pattern and literal-name readings, within writable roots. Read exceptions can also restore runtime-provided write access to home convenience directories, and Linux may require an existing parent directory for file creation. The reviewer receives these additional scopes. Literal filenames containing glob metacharacters remain manual because Tau uses string rules, which can also act as permission patterns.
- **macOS service lookup (Mach):** approval adds the exact service name for one sandboxed retry and its descendants, without changing session policy. The reviewer considers replay of the whole command and the service's ability to perform operations beyond the process sandbox. Ambiguous or wildcard service names remain manual. Tau's bundled runtime honors per-execution OS policy overrides, including Mach service lists.

Cancellation, policy changes, and invalidated sessions revoke pending decisions. Failed retries do not trigger another automatic retry. Classifier decisions appear in `/sandbox doctor` and are not attributed to the user. Classification usage is included in the Bash tool result when available.

Manual approvals retain their existing session-wide policy behavior. Runtime-mandatory protections and sandbox setup failures cannot be overridden by a classifier.

Terminal-status reports may expose approval titles containing commands, paths, or hosts. Disable these reports with `PI_PROGRAM_STATUS=0`.
