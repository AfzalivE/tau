# Scripts

## Standalone sandbox command runner

From the checkout root, run a command through Pi's sandbox-aware Bash tool without a model call:

```bash
./bin/sandbox-run --config ~/.pi/agent/sandbox.json --cwd /path/to/project -- maestro --version
./bin/sandbox-run --config /path/to/policy.json --timeout 30 -c 'npm test | tee test.log'
```

This repo-only command uses the installed Pi SDK and this checkout's sandbox extension. Run `npm install` in the Tau checkout first. It loads no other extensions, skills, prompts, model configuration, or stored credentials. It keeps the Pi session in memory and writes the normal sandbox audit log. The log path is printed to stderr.

- `--config` replaces global and project sandbox files. The file path is resolved from the launch directory; relative paths inside the policy use `--cwd`.
- Without `--config`, the extension uses its defaults, the global `sandbox.json`, and a trusted project's `.pi/sandbox.json`. Saved Pi project trust applies. `--trust-project` grants trust only for this run.
- Tau's JVM proxy adapter, SSH wrapper, Git metadata grants, command checks, and violation handling stay active. Each run starts with fresh session permissions.
- Approval prompts are disabled. Disabled configurations, invalid configuration files, and matching command exclusions are refused. The runner sets the extension's `--sandbox-required` flag to prevent unsandboxed Bash execution.
- Output uses Pi's combined stdout/stderr and is printed when the command finishes. Pi's normal truncation and full-output-file handling apply. Command stdin is not connected.
- The runner returns the child exit status reported by Pi, `124` for timeout, `130`/`143` for interruption, `126` for a command-blocklist match, `1` for other failures, and `2` for invalid runner arguments.

Run it from a normal terminal. An outer sandbox still applies and can prevent a second sandbox from starting on macOS. This is a real execution: allowed writes persist, and shared services or daemons can retain state between runs.

Verify the runner from the checkout root with:

```bash
node --test scripts/sandbox-run.test.mjs
```

Native enforcement tests require a normal macOS/Linux terminal. They are skipped inside an existing sandbox.
