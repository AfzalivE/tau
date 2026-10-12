# Sandbox runtime patches

Tau pins `@anthropic-ai/sandbox-runtime` to `0.0.79`. Each upstream fix has its own patch against the released npm package's JavaScript, declarations, and documentation:

- `sandbox-runtime-0.0.79-pr-673.patch`: Linux file-preservation fix [#673](https://github.com/anthropics/sandbox-runtime/pull/673), commit [`fdd5c2d4`](https://github.com/anthropics/sandbox-runtime/commit/fdd5c2d4523bd7b8e707ae377c2631d64798f818).
- `sandbox-runtime-0.0.79-pr-695.patch`: per-command policy handoffs from [#695](https://github.com/anthropics/sandbox-runtime/pull/695), based on commit [`e9137fd9`](https://github.com/anthropics/sandbox-runtime/commit/e9137fd9aa0d90e7b6ba0a82a1e169adc95551ee), plus local, unpublished fixes for its shallow command-config types and documentation scope. Those fixes are not in the linked commit.

The exact version keeps application checked against the audited release. The helper discovers all `.patch` files in this directory and applies them in filename order. No patch list or runtime download is required.

## POSIX per-command policy subset

The exported `SandboxCommandConfig` type accepts partial `network` and `filesystem` sections. Nested path objects and credentials still require their complete types. The table below covers the POSIX policy handoffs patched here, not the complete cross-platform per-command API.

Overrides use field-level `custom ?? session` precedence. Omission falls back, `false` overrides `true`, and `[]` clears optional list grants for that command. Supplying any `filesystem` override defaults its `disabled` to `false`, even if the session disabled filesystem restrictions. Session configuration and zero-argument inspection getters are unchanged.

| Patched fields                                                     | Platforms    |
| ------------------------------------------------------------------ | ------------ |
| `network.allowUnixSockets`, `allowLocalBinding`, `allowMachLookup` | macOS        |
| `network.allowAllUnixSockets`, `filesystem.allowGitConfig`         | macOS, Linux |
| `enableWeakerNetworkIsolation`, `allowAppleEvents`                 | macOS        |
| `enableWeakerNestedSandbox`, `mandatoryDenySearchDepth`            | Linux        |

Existing `allowPty`, filesystem lists/disabled, credential handling, and additive `git.safeDirectories` semantics remain intact. Mandatory protections, including Git hooks, remain enforced. Linux search depth defaults to 3 (valid range 1–10). Lower depth reduces protection. Apple Events can launch unsandboxed applications.

This is not a general configuration merge. Custom `network.allowedDomains` affects isolation/proxy routing and credential injection defaults, but custom allow/deny lists do not replace the live proxy's session policy. An empty custom allowlist does not revoke a session allowance. `ignoreViolations`, proxy/filter/TLS settings, `ripgrep`, `seccomp`, and executable selection remain session/infrastructure scoped. Linux monitors retain session policy. This patch does not change Windows behavior.

## Linux cleanup

The runtime no longer guesses that an existing empty read-only file is a stale sandbox mount point and schedules it for deletion. This preserves legitimate files and mount points belonging to other runtime processes. Only paths found absent during preparation remain eligible for tracking. Unknown leftovers from killed runtime processes are deliberately left in place.

## Development

`npm install` / `npm ci` run `scripts/sandbox-runtime.mjs` to apply the patches to this checkout's dependency. Git is required. If installation scripts were deliberately disabled, run `npm run postinstall` before testing. Each patch is checked and skipped if already applied. An empty patch directory, a different runtime version, or an incompatible patch fails instead of silently skipping fixes. Application stops at the first failure; earlier patches remain applied. After revising or removing patches, use `npm ci` to replace the previously patched dependency.

## Packaging

`npm run package` copies the installed runtime and its production dependencies into each staged Tau package, patches that private copy, and declares it in `bundleDependencies`. Packaging does not patch the source dependency. The runtime's upstream license and platform binaries are retained.

Published packages contain the corrected code and need no consumer-side patch hook, including when installation scripts are disabled. The larger archives trade dependency sharing for predictable, package-local behavior.

Artifact tests verify the checked patches, ordered discovery, macOS profile scalar/list overrides, Linux command generation, cleanup file preservation, and type-checked minimal consumers of both public wrappers for both distributions. Generated profiles/commands are not native enforcement evidence. When updating the runtime, review the patch and dependency tree, then verify packaged artifacts and native policy isolation on macOS and Linux. Remove the corresponding patch file when adopting a release that includes its fix.
