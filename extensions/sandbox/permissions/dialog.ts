import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { showSandboxPermissionSelect, type SandboxPermissionPrompt } from "./prompt.js";

type PermissionDecision = "allow-retry" | "allow-always" | "allow-adapt" | "deny";

export type PermissionResolution =
  | {
      kind: "allow-retry";
      message: string;
      retrySuccessMessage: string;
      retryFailureMessage: string;
      retrySkippedMessage: string;
    }
  | { kind: "allow-adapt"; message: string }
  | { kind: "deny"; message: string };

const ALLOW_RETRY_OPTION = "Allow and retry now";
export const ALWAYS_ALLOW_RETRY_OPTION = "Always allow and retry";
const ALLOW_ADAPT_OPTION = "Allow but adapt for side-effects";
const DENY_OPTION = "Deny";

export async function showPermissionDialog<T>(options: {
  ctx: ExtensionContext;
  prompt: SandboxPermissionPrompt;
  promptKey: string;
  pendingDialogs?: Map<string, Promise<T | null>>;
  autoRetryAvailable: boolean;
  canSave?: boolean;
  onDecision: (decision: PermissionDecision) => T | Promise<T>;
}): Promise<T | null> {
  const {
    ctx,
    prompt,
    promptKey,
    pendingDialogs,
    autoRetryAvailable,
    canSave = false,
    onDecision,
  } = options;
  const existingDialog = pendingDialogs?.get(promptKey);
  if (existingDialog) return existingDialog;

  const dialogTask: Promise<T | null> = (async () => {
    try {
      const selection = await showSandboxPermissionSelect(
        ctx,
        prompt,
        getPermissionDialogOptions(autoRetryAvailable, canSave),
      );
      return await onDecision(
        parsePermissionDialogSelection(selection, autoRetryAvailable, canSave),
      );
    } catch {
      return onDecision("deny");
    }
  })();

  if (!pendingDialogs) return dialogTask;

  pendingDialogs.set(promptKey, dialogTask);
  try {
    return await dialogTask;
  } finally {
    pendingDialogs.delete(promptKey);
  }
}

export function createPermissionResolution(
  decision: PermissionDecision,
  blockedTarget: string,
  changed = true,
): PermissionResolution {
  if (decision === "deny") {
    return { kind: "deny", message: formatDeniedMessage(blockedTarget) };
  }

  if (decision === "allow-retry" || decision === "allow-always") {
    const scope = decision === "allow-always" ? "globally for future sessions" : "for this session";
    return {
      kind: "allow-retry",
      message: formatAllowRetryMessage(blockedTarget),
      retrySuccessMessage: formatRetrySucceededMessage(blockedTarget, scope),
      retryFailureMessage: formatRetryFailedMessage(blockedTarget, scope),
      retrySkippedMessage: formatRetrySkippedMessage(blockedTarget, scope),
    };
  }

  return {
    kind: "allow-adapt",
    message: changed
      ? formatAllowAdaptMessage(blockedTarget)
      : formatAlreadyAllowedMessage(blockedTarget),
  };
}

function getPermissionDialogOptions(autoRetryAvailable: boolean, canSave: boolean): string[] {
  if (!autoRetryAvailable) return [ALLOW_ADAPT_OPTION, DENY_OPTION];
  return [
    ALLOW_RETRY_OPTION,
    ...(canSave ? [ALWAYS_ALLOW_RETRY_OPTION] : []),
    ALLOW_ADAPT_OPTION,
    DENY_OPTION,
  ];
}

function parsePermissionDialogSelection(
  selection: string | undefined,
  autoRetryAvailable: boolean,
  canSave: boolean,
): PermissionDecision {
  if (selection === ALWAYS_ALLOW_RETRY_OPTION && autoRetryAvailable && canSave)
    return "allow-always";
  if (selection === ALLOW_ADAPT_OPTION) return "allow-adapt";
  if (selection === ALLOW_RETRY_OPTION && autoRetryAvailable) return "allow-retry";
  return "deny";
}

function formatAllowRetryMessage(blockedTarget: string): string {
  return `\n${blockedTarget}\n\nGranting access and retrying the command per user request...\n\n`;
}

function formatAllowAdaptMessage(blockedTarget: string): string {
  return `\n${blockedTarget}\n\nAccess granted for this session. Retry the command manually if appropriate.`;
}

function formatDeniedMessage(blockedTarget: string): string {
  return `\n${blockedTarget}\n\nAccess remains denied for this session.`;
}

function formatAlreadyAllowedMessage(blockedTarget: string): string {
  return `\n${blockedTarget}\n\nAccess had already been granted for this session. The remaining failure may be unrelated to sandbox policy.`;
}

function formatRetrySucceededMessage(blockedTarget: string, scope: string): string {
  return `\n${blockedTarget}\n\nAccess granted ${scope} and the command was retried successfully.`;
}

function formatRetryFailedMessage(blockedTarget: string, scope: string): string {
  return `\n${blockedTarget}\n\nAccess granted ${scope} and the command was retried per user request, but the command still exited non-zero. The sandbox block was resolved; the remaining failure may be unrelated.`;
}

function formatRetrySkippedMessage(blockedTarget: string, scope: string): string {
  return `\n${blockedTarget}\n\nAccess granted ${scope}, but automatic retry was skipped because the timeout was exhausted. Retry the command manually if needed.`;
}
