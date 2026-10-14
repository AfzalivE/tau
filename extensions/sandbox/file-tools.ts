import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getFileToolAccesses, guardFileToolCall } from "./file-tool-guard.js";
import { proposeFilesystemPermission } from "./permissions/filesystem.js";
import type { SandboxRuntime } from "./runtime.js";

export function registerFileToolGuard(pi: ExtensionAPI, runtime: SandboxRuntime): void {
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
          const config = runtime.getRuntimeConfig();
          if (!config) return { allow: false, reason: inactiveReason };
          const proposal = proposeFilesystemPermission({
            runtimeConfig: config,
            violations: [
              {
                kind: violation.access.kind,
                path: violation.access.path,
                readAccess: violation.access.readAccess,
                matchedRule: violation.matchedRule,
                processName: event.toolName,
              },
            ],
            diagnosticSource: "process-output",
            command,
            cwd: ctx.cwd,
            rawOutput: "",
            autoRetryAvailable: true,
            // A native tool has no sandboxed retry for a temporary classifier exception.
            automaticReviewAvailable: false,
            runtimeProtectedWriteViolations: [],
          });
          if (!proposal) return { allow: false, reason: inactiveReason };
          // Share Bash's permission lane so approvals stay serialized and cancellable.
          const resolution = await runtime.withPermissionLifetime(ctx, ctx.signal, (signal) =>
            runtime.runBash(ctx, signal, (owner) => runtime.resolvePermission(proposal, owner)),
          );
          return { allow: resolution.kind === "allow-retry", reason: resolution.message };
        },
      })) ?? undefined
    );
  });
}
