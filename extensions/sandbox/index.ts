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
import {
  createBashToolDefinition,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { createSandboxedBashOps, createUnsandboxedBashOps } from "./bash.js";
import { registerSandboxCommand } from "./command.js";
import { registerFileToolGuard } from "./file-tools.js";
import { isUnsandboxedApproval, showUnsandboxedApproval } from "./permissions/unsandboxed.js";
import { createSandboxRuntime, getSandboxRunMode } from "./runtime.js";

export default function sandboxExtension(pi: ExtensionAPI): void {
  pi.registerFlag("no-sandbox", {
    description: "Disable OS-level bash sandboxing and native file-tool guardrails",
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
      "Require sandboxed Bash execution; refuse disabled configs, exclusions, and unsandboxed approval",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("sandbox-debug", {
    description: "Enable sandbox-runtime proxy/network debug logs (sets SRT_DEBUG)",
    type: "boolean",
    default: false,
  });

  const runtime = createSandboxRuntime(pi);
  pi.events.on("subagent:unsandboxed-approval", (data) => {
    const request = data as {
      ctx?: ExtensionContext;
      title?: unknown;
      choices?: unknown;
      signal?: AbortSignal;
      result?: Promise<string | undefined>;
    };
    if (
      !request?.ctx ||
      typeof request.title !== "string" ||
      !Array.isArray(request.choices) ||
      !isUnsandboxedApproval(request.choices)
    ) {
      return;
    }
    const { ctx, title } = request;
    const choices = [...request.choices];
    request.result = runtime
      .withPermissionContext(ctx, request.signal, async (_ctx, signal) => {
        if (
          !ctx.hasUI ||
          runtime.required ||
          runtime.state.status !== "active" ||
          runtime.promptMode !== "interactive"
        ) {
          return undefined;
        }
        // The subagent already owns the parent's permission queue. Use the original UI,
        // not the invocation wrapper, to avoid recursively entering that queue.
        const choice =
          ctx.mode === "tui"
            ? await showUnsandboxedApproval(ctx, title, signal)
            : ctx.mode === "rpc"
              ? await ctx.ui.select(title, choices, { signal })
              : undefined;
        return signal.aborted ||
          runtime.required ||
          runtime.state.status !== "active" ||
          runtime.promptMode !== "interactive"
          ? undefined
          : choice;
      })
      .catch(() => undefined);
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
        debug: runtime.config?.debug,
        commands: structuredClone(runtime.config?.commands),
        network: { ...cloned.network, jvmProxy: runtime.config?.network.jvmProxy },
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
  const sandboxedOps = createSandboxedBashOps({
    getContext: () => runtime.context,
    getSandboxConfig: () => runtime.config,
    getRuntimeConfig: () => runtime.getRuntimeConfig(),
    getPromptMode: () => runtime.promptMode,
    getJvmProxyEndpoint: runtime.getJvmProxyEndpoint,
    isRequired: () => runtime.required,
    checkCommand: runtime.checkCommand,
    applyRuntimeConfigForSession: runtime.applyRuntimeConfigForSession,
    savePermission: runtime.savePermission,
    withBashContext: runtime.withBashContext,
    recordEvent: runtime.recordEvent,
  });

  let localBashTool = createBashToolDefinition(process.cwd());
  let sandboxedBashTool = createBashToolDefinition(process.cwd(), { operations: sandboxedOps });

  pi.registerTool({
    ...localBashTool,
    label: "bash (sandbox-aware)",
    description:
      localBashTool.description +
      " Set requestUnsandboxed to true to request fresh human approval for this invocation outside the sandbox. Requires an active sandbox, interactive permission mode, and human UI. Never retries or changes sandbox policy.",
    parameters: Type.Object({
      ...localBashTool.parameters.properties,
      requestUnsandboxed: Type.Optional(
        Type.Boolean({
          description:
            "Request human approval to run this command and its descendants once outside Tau's OS sandbox restrictions (default false).",
        }),
      ),
    }),
    async execute(id, params, signal, onUpdate, ctx) {
      const { command, timeout, requestUnsandboxed } = params;
      const blocked = runtime.checkCommand(command, ctx.cwd);
      if (blocked) throw new Error(blocked);
      if (requestUnsandboxed !== undefined && typeof requestUnsandboxed !== "boolean") {
        throw new Error("requestUnsandboxed must be a boolean.");
      }
      if (requestUnsandboxed === true) {
        return runtime.withPermissionContext(ctx, signal, (invocationContext, invocationSignal) => {
          const operations = createUnsandboxedBashOps(
            runtime,
            sandboxedOps,
            invocationContext,
            invocationSignal,
          );
          const tool = createBashToolDefinition(ctx.cwd, { operations });
          return tool.execute(
            id,
            { command, timeout },
            invocationSignal,
            onUpdate,
            invocationContext,
          );
        });
      }
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
            command,
            cwd: ctx.cwd,
            summary: reason,
          });
          throw new Error(reason);
        }
        return localBashTool.execute(id, params, signal, onUpdate, ctx);
      }

      runtime.captureContext(ctx);
      return sandboxedBashTool.execute(id, params, signal, onUpdate, ctx);
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
    localBashTool = createBashToolDefinition(ctx.cwd);
    sandboxedBashTool = createBashToolDefinition(ctx.cwd, { operations: sandboxedOps });
    await runtime.start(ctx, event.reason);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    await runtime.shutdown(ctx, event.reason);
  });

  registerFileToolGuard(pi, runtime);
  registerSandboxCommand(pi, runtime);
}
