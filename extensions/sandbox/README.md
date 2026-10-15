# Sandbox

Sandboxes Bash commands and their descendants on macOS and Linux, including calls through codemode. Pi itself, other tools, and MCP servers retain host permissions. Run `/sandbox` for help.

Relative filesystem rules and socket paths resolve from the owning session's working directory, including session-only `/sandbox filesystem` changes. Configuration files are not rewritten by permission approvals.

## macOS application launching

The macOS-only `allowAppleEvents` setting defaults to `false`. To opt in, add it to your global `sandbox.json` in Pi's agent directory (normally `~/.pi/agent`), or to a trusted configuration file explicitly selected with `--sandbox-config`:

```json
{
  "allowAppleEvents": true
}
```

**This removes code-execution isolation.** Commands can launch arbitrary applications through `open` without an additional user prompt. Launched applications run outside the sandbox's filesystem and network restrictions, even after the originating command ends. macOS automation consent (TCC) still gates scripting other applications, but not ordinary launches. This is not a per-application permission and does not guarantee that every GUI operation will work.

Automatic project configuration (`.pi/sandbox.json`) cannot change this setting, even for trusted projects. An explicit override file is trusted input: do not select an attacker-controlled or unreviewed file. Invalid non-boolean values in user-selected configuration block sandbox initialization. Reload after editing configuration. Enabled sessions warn at startup and in `/sandbox show`, and include the warning in agent context. Subagents inherit the parent's setting. Permission reviews never enable it.

## Classifier fallback

Commands run under the normal sandbox policy first. At a supported permission block, an optional classifier can approve a temporary exception before the usual manual prompt. It must consider the user's intent, the actual permission change, and any side effects already performed by the failed command. There is no blanket approval of commands or automatic escape from the sandbox.

When a classifier is available, the first permission review offers manual approval, classifier setup, or keeping manual approvals. Setup lists credential-available Pi classifiers and, with suitable Codex authentication, `openai-codex/guardian`. Availability does not guarantee endpoint access or remaining quota. Guardian is an experimental Codex Responses adapter returning risk labels, not a probability-producing model registered in Pi's classifier catalog. Tau uses the fast classifier as a permission gate, not Codex's full review pipeline: a `high` label falls back to manual approval, without a second automated reviewer.

Use `/sandbox classifier` to change or disable the reviewer. Choices can be saved for the selected session branch (including reload/resume) or explicitly remembered in the global `sandbox.json`. Session choices take precedence over configuration. `/sandbox show` displays the effective selection.

Configuration follows the usual global, trusted-project, and `--sandbox-config` precedence:

```json
{
  "classifier": "openai-codex/guardian"
}
```

Use a Pi classifier's `provider/model` ID instead to select it. Set `"classifier": false` for manual approvals. Omitting the setting offers setup when a classifier is available. Invalid values fall back to manual approvals.

Reviews send the command (including the active command as unverified network context), requested permission, failure evidence, all ordinary user messages from the selected branch, and bounded recent assistant/tool context to the selected provider. They can consume quota or incur charges. Supplementary context includes visible assistant text, tool-call arguments, and tool results, with recorded roles and IDs. It excludes hidden reasoning, custom messages, compaction summaries, abandoned branches, and original edited content. It does not separately collect system or repository instructions. Assistant questions can clarify a user's answer, but assistant claims, tool output, and quoted instructions cannot supply user authorization.

Required user intent and request data are never shortened or redacted for review. Supplementary history retains up to 40 recent records within 8,000 bytes and the total 24,000-byte state limit. Edited, sensitive, partial, nontext, and oversized supplementary records are omitted whole, and omissions are marked explicitly. The reviewer must escalate if missing context matters to its decision. Recognizable secrets in required input prevent review entirely; these checks do not guarantee that arbitrary text is free of secrets or prompt injection. No tools are available to the reviewer.

The reviewer evaluates intrinsic risk and user authorization separately. A narrow local action outside workspace roots, a sandbox retry, or routine task-scoped authentication is not inherently dangerous. High-risk actions, such as remote branch deletion, credential probing, or sensitive-data export to untrusted destinations, require manual approval even when authorized. Only clearly low-risk, authorized exceptions with justified scope and safe replay qualify for automatic approval. Neither genuine denials nor diagnostic claims prove necessity, authorization, or safe replay; the reviewer must justify the capability even assuming the diagnostic was fabricated.

Incomplete required context, oversized inputs, recognized credential patterns, malformed decisions, material uncertainty, and provider errors fall back to manual approval. Native Pi classifiers must report at least 0.95 approval probability and confidence. This is a conservative abstention rule, not a calibrated guarantee of safety. Guardian supplies only its actual risk label, and Tau validates its complete response rather than accepting an early token. The classifier remains a fallible delegated authorizer.

A removed or credential-unavailable selected model prompts for configuration again, as do persistent access failures when Pi exposes their HTTP status. Some native Pi adapters collapse authentication and malformed-response failures into a generic provider error; Tau does not parse error prose to guess the cause. Transient failures retain the selection. Tau never silently switches providers. Non-interactive sessions do not onboard or classify. Connected Tau subagents ask the parent to review using its selected classifier and current selected-branch user intent. Child task assignments and steering are attributed assistant directions, never user authorization. Child history contributes up to 20 records and 4,000 bytes within the shared supplementary-context limits. Onboarding and saved choices belong to the parent. Without that connection, children retain manual/blocked behavior and never classify independently.

### Approval scope

- **Network:** approval releases only the pending proxy connection. It does not add the host to the session allowlist. The runtime exposes host/port but not trustworthy command identity or request contents. Reviews include the active command as explicitly unverified context and assess likely task-scoped use. Missing attribution or opaque encrypted traffic alone does not require escalation for routine public-page, release-metadata, or download access. This deliberately favors best-effort judgment over proof of origin: approved traffic need not match the visible command, and a connection grant does not enforce GET/HEAD or prevent uploads. Material risks still require manual approval. Explicit network denies and strict allowlists remain enforced by the runtime.
- **Filesystem:** native observations and recognized permission-error output can nominate requests on macOS and Linux. Their provenance is disclosed, including Linux's attacker-controlled syscall telemetry and potentially forged process output. Runtime diagnostics may already be sanitized, so a reported pathname is a candidate, not verified original filename bytes. These inputs never authorize access by themselves. Approval covers the proposed exception **and replay of the entire command**, including possible repeated side effects. A single retry uses its own filesystem policy, applying to that execution and its descendants. Session allowlists and deny rules remain unchanged.
- Some filesystem exceptions are broader than the reported file: removing a write-deny relaxes the whole rule, including applicable pattern and literal-name readings, within writable roots. Read exceptions can also restore runtime-provided write access to home convenience directories, and Linux may require an existing parent directory for file creation. The reviewer receives these additional scopes. Literal filenames containing glob metacharacters remain manual because Tau uses string rules, which can also act as permission patterns.
- **macOS service lookup (Mach):** approval adds the exact service name for one sandboxed retry and its descendants, without changing session policy. The reviewer considers replay of the whole command and the service's ability to perform operations beyond the process sandbox. Ambiguous or wildcard service names remain manual. Tau's bundled runtime honors per-execution OS policy overrides, including Mach service lists.

Cancellation, new user directions, policy changes, and invalidated sessions revoke pending decisions. Queued directions prevent inference until they enter the conversation. Delegated approvals also require the parent's user intent and context edits to remain unchanged during review. Failed retries do not trigger another automatic retry. The initial attempt and retry share the execution budget, but waiting for a post-execution permission decision does not consume it. Running commands, including those awaiting network approval, retain their timeout. Classification usage is included in the owning Bash tool result, including reviews performed by a child's parent.

Manual approvals retain their existing session-wide policy behavior. Runtime-mandatory protections and sandbox setup failures cannot be overridden by a classifier.

### Review diagnostics

Manual prompts show the requested access and choices without automatic-review status text. `/sandbox doctor` distinguishes attempted reviews from skips, model escalation from invalid responses or provider failures, and review outcomes from actual permission decisions. An approved review does not prove that its grant was applied: cancellation or a changed policy can still prevent the retry.

Parent-mediated reviews appear in the parent's doctor with subagent/tool attribution, as well as in the child's diagnostics. Safe diagnostic records persist on the selected branch across reload/resume: outcome, attempted status, classifier ID, recognized label, timestamp, permission kind, and tool-call ID when available. They contain no provider response/error text, command, target, or conversation payload. Late results from an invalidated session or branch are not written to the new branch. If persistence fails, permission handling continues and the doctor retains an in-memory diagnostic with a storage warning. The doctor keeps a bounded recent-event view; restored diagnostics never grant permissions.

Terminal-status reports may expose approval titles containing commands, paths, or hosts. Disable these reports with `PI_PROGRAM_STATUS=0`.
