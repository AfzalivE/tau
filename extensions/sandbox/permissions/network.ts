import type { SandboxAskCallback, SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PromptMode } from "../config.js";
import { createNetworkAskCallback, type NetworkSandboxEvent } from "../network-permission.js";
import { showSandboxPermissionSelect } from "./prompt.js";
import { ALWAYS_ALLOW_RETRY_OPTION } from "./dialog.js";
import type { SandboxRuntime } from "../runtime.js";

export function createNetworkPermissions(options: {
  getContext: () => ExtensionContext | null;
  getPromptMode: () => PromptMode;
  getRuntimeConfig: () => SandboxRuntimeConfig | null;
  isSuspended: () => boolean;
  applyRuntimeConfigForSession: (ctx: ExtensionContext, config: SandboxRuntimeConfig) => void;
  savePermission: SandboxRuntime["savePermission"];
  recordEvent: (event: NetworkSandboxEvent) => void;
  notify: (ctx: ExtensionContext, text: string, level?: "info" | "warning" | "error") => void;
}) {
  const pendingApprovals = new Map<string, Promise<boolean>>();
  return {
    ask: (request: Parameters<SandboxAskCallback>[0]) => {
      const ctx = options.getContext();
      return createNetworkAskCallback({
        getRuntimeConfig: options.getRuntimeConfig,
        getPromptMode: options.getPromptMode,
        isSuspended: options.isSuspended,
        pendingApprovals,
        canPrompt: () => Boolean(ctx?.hasUI),
        requestApproval: async ({ target }): Promise<boolean | "always"> => {
          if (!ctx?.hasUI) return false;
          const selection = await showSandboxPermissionSelect(
            ctx,
            {
              request: "Network connection",
              target,
              targetLabel: "host",
              typeCode: "NET_OUT",
            },
            ["Yes", ALWAYS_ALLOW_RETRY_OPTION, "No"],
          );
          return selection === ALWAYS_ALLOW_RETRY_OPTION ? "always" : selection === "Yes";
        },
        saveApproval: async (host) => {
          return ctx
            ? options.savePermission(ctx, {
                section: "network",
                list: "allowedDomains",
                op: "add",
                value: host,
                target: host,
              })
            : false;
        },
        applyRuntimeConfig: (config) => {
          if (ctx) options.applyRuntimeConfigForSession(ctx, config);
        },
        recordEvent: options.recordEvent,
        getCwd: () => ctx?.cwd ?? process.cwd(),
        notify: (message, level) => {
          if (ctx) options.notify(ctx, message, level);
          else console.warn(message);
        },
      })(request);
    },
    clear: () => pendingApprovals.clear(),
  };
}
