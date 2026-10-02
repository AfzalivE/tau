import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getFileToolAccesses, guardFileToolCall } from "./file-tool-guard.js";
import { handleFilesystemViolation } from "./permissions/filesystem.js";
import type { PermissionResolution } from "./permissions/dialog.js";
import type { SandboxRuntime } from "./runtime.js";

export function registerFileToolGuard(pi: ExtensionAPI, runtime: SandboxRuntime): void {
  const pendingDialogs = new Map<string, Promise<PermissionResolution | null>>();
  pi.on("session_shutdown", () => {
    pendingDialogs.clear();
  });
  pi.on("tool_call", async (event, ctx) => {
    const accesses = getFileToolAccesses(event.toolName, event.input, ctx.cwd);
    if (!accesses) return;
    const inactiveReason =
      "Sandbox is not active and native file-tool execution is blocked. Fix sandbox setup and run /sandbox enable, or restart with --no-sandbox.";
    if (runtime.state.status !== "active") {
      if (!runtime.required && ["bypassed", "suspended"].includes(runtime.state.status)) return;
      runtime.recordEvent({
        timestamp: Date.now(),
        kind: "runtime",
        outcome: "blocked",
        reason: "unknown",
        command: event.toolName,
        cwd: ctx.cwd,
        target: accesses[0]?.path,
        summary: inactiveReason,
      });
      return { block: true, reason: inactiveReason };
    }
    return (
      (await guardFileToolCall({
        toolName: event.toolName,
        input: event.input,
        cwd: ctx.cwd,
        getRuntimeConfig: runtime.getRuntimeConfig,
        onViolation: async (violation) => {
          const command = `${event.toolName} ${violation.access.path}`;
          if (violation.reason === "runtime-protected-write") {
            runtime.recordEvent({
              timestamp: Date.now(),
              kind: "filesystem",
              outcome: "blocked",
              reason: violation.reason,
              target: violation.access.path,
              command,
              cwd: ctx.cwd,
              summary: "native file-tool write is protected by the sandbox runtime",
            });
            return {
              allow: false,
              reason: `Sandbox blocked filesystem write to ${violation.access.path}: ${violation.matchedRule} is protected by sandbox-runtime and cannot be allowed for this session.`,
            };
          }
          return runtime.withPermissionContext(ctx, ctx.signal, async (permissionContext) => {
            const config = runtime.getRuntimeConfig();
            if (!config) return { allow: false, reason: inactiveReason };
            const resolution = await handleFilesystemViolation({
              ctx: permissionContext,
              promptMode: runtime.promptMode,
              runtimeConfig: config,
              getRuntimeConfig: runtime.getRuntimeConfig,
              output: "",
              rawOutput: "",
              command,
              cwd: ctx.cwd,
              explicitViolation: {
                kind: violation.access.kind,
                path: violation.access.path,
                readAccess: violation.access.readAccess,
                matchedRule: violation.matchedRule,
                processName: event.toolName,
              },
              pendingDialogs,
              applyRuntimeConfigForSession: runtime.applyRuntimeConfigForSession,
              recordEvent: runtime.recordEvent,
              autoRetryAvailable: true,
            });
            return { allow: resolution?.kind === "allow-retry", reason: resolution?.message };
          });
        },
      })) ?? undefined
    );
  });
}
