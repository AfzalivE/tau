import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SandboxReviewRequest } from "../classifier.js";
import {
  cloneRuntimeConfig,
  escapeSlashCommandArg,
  getFilesystemListValues,
  mutateStringList,
  type PromptMode,
  type SandboxPolicy,
} from "../config.js";
import type { SandboxEvent, SandboxInvocation } from "../runtime.js";
import { mutateMachLookupAllowList } from "./mach-lookup.js";
import type { PermissionProposal, TemporaryPermissionGrant } from "./proposal.js";

type PermissionDecision = "allow-retry" | "allow-adapt" | "deny";

export type PermissionResolution =
  | { kind: "allow-connection"; message?: never }
  | {
      kind: "allow-retry";
      message: string;
      blockedTarget: string;
      grant?: TemporaryPermissionGrant;
    }
  | { kind: "allow-adapt" | "deny"; message: string };

const ALLOW_RETRY_OPTION = "Allow and retry now";
const ALLOW_ADAPT_OPTION = "Allow but adapt for side-effects";
const DENY_OPTION = "Deny";

/** One authorization point for process retries and pending proxy connections. */
export function createPermissionResolver(options: {
  getPromptMode: () => PromptMode;
  getRuntimeConfig: () => SandboxPolicy | null;
  applyRuntimeConfigForSession: (ctx: ExtensionContext, config: SandboxPolicy) => void;
  review: (
    invocation: SandboxInvocation,
    request: SandboxReviewRequest,
  ) => Promise<string | undefined>;
  recordEvent: (event: SandboxEvent) => void;
  notify: (ctx: ExtensionContext, text: string, level?: "info" | "warning" | "error") => void;
}): (proposal: PermissionProposal, invocation: SandboxInvocation) => Promise<PermissionResolution> {
  // Only manual grants share a decision: they authorize the host for the session.
  const pendingNetworkApprovals = new Map<string, Promise<PermissionResolution>>();

  async function resolve(
    proposal: PermissionProposal,
    invocation: SandboxInvocation,
  ): Promise<PermissionResolution> {
    const { ctx, signal } = invocation;
    const blockedTarget = `${permissionTitle(proposal)}.`;
    const denied = () => createPermissionResolution("deny", blockedTarget);
    if (signal.aborted) return denied();
    if (options.getPromptMode() === "non-interactive" || !ctx.hasUI) {
      record(proposal, "blocked");
      const message = `${permissionSummary(proposal)}\n[sandbox] To temporarily allow for this session, run: ${permissionCommand(proposal)}`;
      if (proposal.kind === "network") options.notify(ctx, message, "warning");
      return { kind: "deny", message };
    }
    if (proposal.alreadyApplied) {
      record(proposal, "blocked");
      return createPermissionResolution("allow-adapt", blockedTarget, false);
    }

    if (proposal.automatic && options.getRuntimeConfig() === proposal.policy) {
      const classifier = await options.review(invocation, {
        kind: proposal.kind,
        command: proposal.command,
        cwd: proposal.cwd,
        target: proposal.target,
        operation: proposal.operation,
        permission: proposal.automatic.permission,
        retry: proposal.kind !== "network",
        evidence: proposal.automatic.evidence,
      });
      if (signal.aborted) return denied();
      const current = options.getRuntimeConfig() === proposal.policy;
      if (classifier && current) {
        const connection = proposal.kind === "network";
        record(
          proposal,
          "allowed",
          connection
            ? `classifier ${classifier} approved one pending connection; session policy unchanged`
            : `classifier ${classifier} approved a temporary exception and one sandboxed retry`,
        );
        if (proposal.kind === "network") return { kind: "allow-connection" };
        return {
          kind: "allow-retry",
          blockedTarget,
          grant: { config: proposal.automatic.config, policy: proposal.policy },
          message: `\n[sandbox] Classifier ${classifier} approved a temporary ${proposal.kind} exception and one retry. Session policy is unchanged.\n`,
        };
      }
      // A proxy request must go through the native matcher again after a policy change.
      if (!current && proposal.kind === "network") return denied();
    }
    if (signal.aborted) return denied();
    if (proposal.kind !== "network") return manual(proposal, invocation);

    const key = proposal.action.value;
    const pending = pendingNetworkApprovals.get(key);
    if (pending) return pending;
    const decision = manual(proposal, invocation);
    pendingNetworkApprovals.set(key, decision);
    try {
      return await decision;
    } finally {
      if (pendingNetworkApprovals.get(key) === decision) pendingNetworkApprovals.delete(key);
    }
  }

  async function manual(
    proposal: PermissionProposal,
    { ctx, prompts, signal }: SandboxInvocation,
  ): Promise<PermissionResolution> {
    const title = permissionTitle(proposal);
    const blockedTarget = `${title}.`;
    let decision: PermissionDecision = "deny";
    try {
      if (proposal.kind === "network") {
        if (await prompts.confirm(title, "\nAllow for this session?")) decision = "allow-adapt";
      } else {
        const choices = proposal.autoRetryAvailable
          ? [ALLOW_RETRY_OPTION, ALLOW_ADAPT_OPTION, DENY_OPTION]
          : [ALLOW_ADAPT_OPTION, DENY_OPTION];
        const selection = await prompts.select(title, choices);
        if (selection === ALLOW_ADAPT_OPTION) decision = "allow-adapt";
        if (selection === ALLOW_RETRY_OPTION && proposal.autoRetryAvailable)
          decision = "allow-retry";
      }
    } catch (error) {
      if (proposal.kind === "network" && !signal.aborted) {
        options.notify(
          ctx,
          `Sandbox permission prompt failed for ${proposal.action.value}: ${error instanceof Error ? error.message : error}`,
          "warning",
        );
      }
    }
    const latest = options.getRuntimeConfig();
    if (
      signal.aborted ||
      decision === "deny" ||
      !latest ||
      (proposal.kind === "network" && latest !== proposal.policy)
    ) {
      record(proposal, "blocked");
      return createPermissionResolution("deny", blockedTarget);
    }

    // Apply only the nominated action to the latest policy. Classifier grants never reach here.
    const next = cloneRuntimeConfig(latest);
    const changed = applyAction(next, proposal.action);
    if (changed) options.applyRuntimeConfigForSession(ctx, next);
    record(proposal, "allowed");
    if (proposal.kind === "network") {
      options.notify(
        ctx,
        `Allowed network domain for this session: ${proposal.action.value}`,
        "info",
      );
      return { kind: "allow-connection" };
    }
    return createPermissionResolution(decision, blockedTarget, changed);
  }

  function record(
    proposal: PermissionProposal,
    outcome: "allowed" | "blocked",
    summary = permissionEventSummary(proposal, outcome),
  ): void {
    options.recordEvent({
      timestamp: Date.now(),
      kind: proposal.kind,
      outcome,
      reason: proposal.reason,
      target: proposal.target,
      command: proposal.command,
      cwd: proposal.cwd,
      summary,
      suggestedCommand:
        outcome === "blocked" && !proposal.alreadyApplied ? permissionCommand(proposal) : undefined,
    });
  }

  return resolve;
}

function permissionTitle(proposal: PermissionProposal): string {
  if (proposal.kind === "filesystem") {
    const operation =
      proposal.operation === "read"
        ? "read from"
        : proposal.operation === "write"
          ? "write to"
          : "access to";
    return `Sandbox blocked filesystem ${operation} ${proposal.target}`;
  }
  if (proposal.kind === "mach-lookup") {
    return `Sandbox blocked access to macOS service ${proposal.target}`;
  }
  return `Sandbox blocked network access to ${proposal.target}`;
}

function permissionSummary(proposal: PermissionProposal): string {
  if (proposal.kind === "filesystem") {
    const operation = ["read", "write"].includes(proposal.operation)
      ? proposal.operation
      : "access";
    return `[sandbox] Blocked filesystem ${operation}: ${proposal.target}`;
  }
  if (proposal.kind === "mach-lookup") {
    return `[sandbox] Blocked macOS service lookup: ${proposal.target}`;
  }
  return `Sandbox blocked network access to ${proposal.action.value}.`;
}

function permissionCommand(proposal: PermissionProposal): string {
  const { list, op, value } = proposal.action;
  const argument = escapeSlashCommandArg(value);
  if (list === "mach-lookup") return `/sandbox mach-lookup ${op} ${argument}`;
  if (list === "network-allow") return `/sandbox network allow ${op} ${argument}`;
  return `/sandbox filesystem ${list} ${op} ${argument}`;
}

function permissionEventSummary(
  proposal: PermissionProposal,
  outcome: "allowed" | "blocked",
): string {
  const { kind, reason, operation } = proposal;
  if (kind === "network") {
    return outcome === "allowed"
      ? "user allowed network domain for this session"
      : "network access target is not in the allowed domain list";
  }
  if (kind === "mach-lookup") {
    if (outcome === "allowed") return "user allowed macOS service lookup for this session";
    return reason === "already-approved-still-failed"
      ? "macOS service lookup was previously allowed for this session but is still failing"
      : "macOS service lookup is not in the allowed service list";
  }
  if (outcome === "allowed") {
    if (reason === "explicit-deny-read") return "user allowed filesystem read for this session";
    if (reason === "explicit-deny-write") return "user allowed filesystem write for this session";
    if (reason === "missing-allow-write" && operation !== "unknown") {
      return "user allowed filesystem write path for this session";
    }
    return "user allowed filesystem access for this session";
  }
  if (reason === "explicit-deny-read") return "filesystem read matched a deny-read rule";
  if (reason === "explicit-deny-write") return "filesystem write matched a deny-write rule";
  if (reason === "runtime-protected-write") {
    return "filesystem write is protected by the sandbox runtime";
  }
  if (reason === "already-approved-still-failed") {
    return "filesystem access was previously allowed for this session but is still failing";
  }
  if (reason === "missing-allow-write") {
    return operation === "unknown"
      ? "filesystem access fell outside the current allow-write paths"
      : "filesystem write fell outside the current allow-write paths";
  }
  return "sandbox blocked filesystem access";
}

function applyAction(config: SandboxPolicy, action: PermissionProposal["action"]): boolean {
  if (action.list === "mach-lookup")
    return mutateMachLookupAllowList(config, action.op, action.value);
  const values =
    action.list === "network-allow"
      ? config.network.allowedDomains
      : getFilesystemListValues(config, action.list);
  return mutateStringList(values, action.op, action.value);
}

function createPermissionResolution(
  decision: PermissionDecision,
  blockedTarget: string,
  changed = true,
): PermissionResolution {
  if (decision === "deny") {
    return {
      kind: "deny",
      message: `\n${blockedTarget}\n\nAccess remains denied for this session.`,
    };
  }
  if (decision === "allow-retry") {
    return {
      kind: "allow-retry",
      blockedTarget,
      message: `\n${blockedTarget}\n\nGranting access and retrying the command per user request...\n\n`,
    };
  }
  return {
    kind: "allow-adapt",
    message: changed
      ? `\n${blockedTarget}\n\nAccess granted for this session. Retry the command manually if appropriate.`
      : `\n${blockedTarget}\n\nAccess had already been granted for this session. The remaining failure may be unrelated to sandbox policy.`,
  };
}
