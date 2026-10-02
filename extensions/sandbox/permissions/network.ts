import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PromptMode } from "../config.js";
import { createNetworkAskCallback, type NetworkSandboxEvent } from "../network-permission.js";
import { showSandboxPermissionSelect } from "./prompt.js";

export function createNetworkPermissions(options: {
  getContext: () => ExtensionContext | null;
  getPromptMode: () => PromptMode;
  getRuntimeConfig: () => SandboxRuntimeConfig | null;
  isSuspended: () => boolean;
  applyRuntimeConfigForSession: (ctx: ExtensionContext, config: SandboxRuntimeConfig) => void;
  recordEvent: (event: NetworkSandboxEvent) => void;
  notify: (ctx: ExtensionContext, text: string, level?: "info" | "warning" | "error") => void;
}) {
  const pendingApprovals = new Map<string, Promise<boolean>>();
  return {
    ask: createNetworkAskCallback({
      getRuntimeConfig: options.getRuntimeConfig,
      getPromptMode: options.getPromptMode,
      isSuspended: options.isSuspended,
      pendingApprovals,
      canPrompt: () => Boolean(options.getContext()?.hasUI),
      requestApproval: async ({ target }) => {
        const ctx = options.getContext();
        if (!ctx?.hasUI) return false;
        return (
          (await showSandboxPermissionSelect(
            ctx,
            {
              request: "Network connection",
              target,
              targetLabel: "host",
              typeCode: "NET_OUT",
            },
            ["Yes", "No"],
          )) === "Yes"
        );
      },
      applyRuntimeConfig: (config) => {
        const ctx = options.getContext();
        if (ctx) options.applyRuntimeConfigForSession(ctx, config);
      },
      recordEvent: options.recordEvent,
      getCwd: () => options.getContext()?.cwd ?? process.cwd(),
      notify: (message, level) => {
        const ctx = options.getContext();
        if (ctx) options.notify(ctx, message, level);
        else console.warn(message);
      },
    }),
    clear: () => pendingApprovals.clear(),
  };
}
