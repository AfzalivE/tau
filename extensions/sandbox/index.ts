/**
 * Sandbox Extension - OS-level sandboxing for bash commands
 *
 * Uses @anthropic-ai/sandbox-runtime to enforce filesystem and network
 * restrictions on bash commands at the OS level (sandbox-exec on macOS,
 * bubblewrap on Linux). PowerShell is intentionally not registered or sandboxed
 * because Tau does not officially support Windows.
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/sandbox.json (global)
 * - <cwd>/.pi/sandbox.json (project-local)
 *
 * If `--sandbox-config <path>` is provided, that file replaces the global/project
 * config files for the session. Relative paths resolve from the session cwd.
 *
 * Note: list fields are overridden (replaced), not concatenated.
 *
 * Example .pi/sandbox.json:
 * ```json
 * {
 *   "enabled": true,
 *   "mode": "interactive",
 *   "network": {
 *     "allowedDomains": ["github.com", "*.github.com"],
 *     "deniedDomains": [],
 *     "allowMachLookup": [
 *       "com.apple.dnssd.service",
 *       "com.apple.SystemConfiguration.configd",
 *       "com.apple.SystemConfiguration.DNSConfiguration",
 *       "com.apple.FSEvents"
 *     ]
 *   },
 *   "filesystem": {
 *     "denyRead": ["~/.ssh", "~/.aws"],
 *     "allowWrite": ["."],
 *     "denyWrite": [".env"],
 *     "allowTempDirs": true,
 *     "allowGitCommonDir": true
 *   }
 * }
 * ```
 *
 * Usage:
 * - `pi -e ./sandbox` - sandbox enabled with default/config settings
 * - `pi -e ./sandbox --no-sandbox` - disable sandboxing
 * - `pi -e ./sandbox --sandbox-config ./sandbox.json` - use a custom sandbox config file
 * - `/sandbox` - show command help
 *
 * Setup for source checkouts:
 * - Run `npm install` from the repository root.
 *
 * macOS also requires: ripgrep
 * Linux also requires: bubblewrap, socat, ripgrep
 */

import { fileURLToPath } from "node:url";
import type { Usage } from "@earendil-works/pi-ai";
import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createSandboxedBashOps } from "./bash.js";
import { registerSandboxCommand } from "./command.js";
import { createSandboxRuntime, getSandboxRunMode, type SandboxInvocation } from "./runtime.js";

export default function sandboxExtension(pi: ExtensionAPI): void {
  pi.registerFlag("no-sandbox", {
    description: "Disable OS-level sandboxing for bash commands",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("sandbox-config", {
    description:
      "Use a custom sandbox config file for this session (replaces global/project sandbox.json files)",
    type: "string",
  });

  pi.registerFlag("sandbox-required", {
    description:
      "Require sandboxed Bash execution; refuse disabled configs, invalid configs, and command exclusions",
    type: "boolean",
    default: false,
  });
  const runtime = createSandboxRuntime(pi);
  const failedUsage = new Map<string, Usage>();
  // Pi converts thrown tool errors to results. Restore already-incurred review usage at
  // that public boundary without changing native Bash's cancellation/error behavior.
  pi.on("tool_result", (event) => {
    if (event.toolName !== "bash") return;
    const usage = failedUsage.get(event.toolCallId);
    failedUsage.delete(event.toolCallId);
    if (usage) return { usage: event.usage ? sumUsage([event.usage, usage]) : usage };
  });
  pi.events.on("subagent:sandbox", (data) => {
    const handoff = data as { config?: unknown; extension?: string; error?: string };
    const policy = runtime.getRuntimeConfig();
    if (runtime.state.status === "active" && policy) {
      const cloned = structuredClone(policy);
      handoff.config = {
        ...cloned,
        enabled: true,
        mode: runtime.promptMode,
        required: runtime.required,
        commands: structuredClone(runtime.config?.commands),
        filesystem: {
          ...cloned.filesystem,
          allowTempDirs: false,
          allowGitCommonDir: runtime.config?.filesystem.allowGitCommonDir ?? false,
        },
      };
    } else if (runtime.state.status === "bypassed" || runtime.state.status === "suspended") {
      if (runtime.required) handoff.error = "Sandbox is required but is not active.";
      else handoff.config = { enabled: false, commands: structuredClone(runtime.config?.commands) };
    } else {
      handoff.error = "Sandbox is not ready. Fix its setup before starting a subagent.";
    }
    handoff.extension = fileURLToPath(import.meta.url);
  });
  const localBashTool = createBashToolDefinition(process.cwd());
  pi.registerTool({
    ...localBashTool,
    label: "bash (sandbox-aware)",
    async execute(id, params, signal, onUpdate, ctx) {
      const blocked = runtime.checkCommand(params.command, ctx.cwd);
      if (blocked) throw new Error(blocked);
      const state = runtime.state;
      if (state.status !== "active") {
        const allowsUnsandboxed =
          !runtime.required && (state.status === "bypassed" || state.status === "suspended");
        if (!allowsUnsandboxed) {
          const runMode = getSandboxRunMode(state);

          let reason =
            "Sandbox is not active and unsandboxed execution is blocked. Fix sandbox setup and run /sandbox enable, or restart with --no-sandbox.";
          if (runMode === "unsupported-platform") {
            reason =
              "Sandbox is unsupported on this platform. Re-run with --no-sandbox to allow unsandboxed execution.";
          } else if (runMode === "missing-dependencies") {
            reason =
              "Sandbox dependencies are missing. Fix sandbox setup and run /sandbox enable, or restart with --no-sandbox to allow unsandboxed execution.";
          } else if (runMode === "init-failed") {
            reason =
              "Sandbox initialization failed. Run /sandbox enable to retry, or restart with --no-sandbox.";
          } else if (runMode === "sandbox") {
            reason =
              "Sandbox session initialization is incomplete. Retry after session startup or run /sandbox enable.";
          }

          if (runtime.required)
            reason = `Sandbox is required but is not active (${runMode}). Check the configuration and sandbox startup diagnostics.`;
          runtime.recordEvent({
            timestamp: Date.now(),
            kind: "runtime",
            outcome: "blocked",
            reason: state.status === "blocked" ? state.reason : "unknown",
            command: params.command,
            cwd: ctx.cwd,
            summary: reason,
          });
          throw new Error(reason);
        }
        return localBashTool.execute(id, params, signal, onUpdate, ctx);
      }

      return runtime.withPermissionLifetime(ctx, signal, async (toolSignal) => {
        let invocation: SandboxInvocation | undefined;
        const tool = createBashToolDefinition(ctx.cwd, {
          operations: {
            exec(command, cwd, options) {
              // Keep queue rejection and cancellation inside native Bash's output/error handling.
              return runtime.runBash(ctx, toolSignal, (owner) => {
                invocation = owner;
                return createSandboxedBashOps({
                  ctx: owner.ctx,
                  getSandboxConfig: () => runtime.config,
                  getRuntimeConfig: () => runtime.getRuntimeConfig(),
                  applyRuntimeConfigForSession: runtime.applyRuntimeConfigForSession,
                  isRequired: () => runtime.required,
                  checkCommand: runtime.checkCommand,
                  recordEvent: runtime.recordEvent,
                  resolvePermission: (proposal) => runtime.resolvePermission(proposal, owner),
                }).exec(command, cwd, { ...options, signal: owner.signal });
              });
            },
          },
        });
        try {
          const result = await tool.execute(id, params, toolSignal, onUpdate, ctx);
          return invocation?.usages.length
            ? { ...result, usage: sumUsage(invocation.usages) }
            : result;
        } catch (error) {
          if (invocation?.usages.length) failedUsage.set(id, sumUsage(invocation.usages));
          throw error;
        }
      });
    },
  });

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "bash" || typeof event.input.command !== "string") return;
    const reason = runtime.checkCommand(event.input.command, ctx.cwd);
    return reason ? { block: true, reason } : undefined;
  });
  pi.on("user_bash", (event, ctx) => {
    const reason = runtime.checkCommand(event.command, ctx.cwd);
    if (reason)
      return {
        result: { output: `${reason}\n`, exitCode: 126, cancelled: false, truncated: false },
      };
  });

  pi.on("session_start", async (event, ctx) => {
    await runtime.start(ctx, event.reason);
    failedUsage.clear();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await runtime.shutdown(ctx);
    failedUsage.clear();
  });

  registerSandboxCommand(pi, runtime);
}

function sumUsage(usages: Usage[]): Usage {
  const total: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  for (const usage of usages) {
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
      total[key] += usage[key];
    }
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
      total.cost[key] += usage.cost[key];
    }
    for (const key of ["cacheWrite1h", "reasoning"] as const) {
      if (usage[key] !== undefined) total[key] = (total[key] ?? 0) + usage[key];
    }
  }
  return total;
}
