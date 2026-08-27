import type { SandboxAskCallback, SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { PromptMode, SandboxEventBase, SandboxEventOutcome } from "./types.js";

export type NetworkEventReason = "explicit-deny-domain" | "missing-allowed-domain";
export type NetworkSandboxEvent = SandboxEventBase<"network", NetworkEventReason>;

export interface NetworkApprovalRequest {
  host: string;
  port?: number;
  target: string;
  suggestedCommand: string;
}

export interface NetworkPermissionOptions {
  getRuntimeConfig: () => SandboxRuntimeConfig | null;
  isSuspended: () => boolean;
  getPromptMode: () => PromptMode;
  canPrompt: () => boolean;
  requestApproval: (request: NetworkApprovalRequest) => Promise<boolean>;
  applyRuntimeConfig: (runtimeConfig: SandboxRuntimeConfig) => void;
  recordEvent: (event: NetworkSandboxEvent) => void;
  notify: (message: string, level: "info" | "warning") => void;
  getCwd: () => string;
  pendingApprovals?: Map<string, Promise<boolean>>;
  now?: () => number;
}

export function createNetworkAskCallback(options: NetworkPermissionOptions): SandboxAskCallback {
  const pendingApprovals = options.pendingApprovals ?? new Map<string, Promise<boolean>>();

  return async ({ host, port }) => {
    if (options.isSuspended()) return true;

    const normalizedHost = host.toLowerCase();
    const existingDecision = pendingApprovals.get(normalizedHost);
    if (existingDecision) return existingDecision;

    const decision = resolveNetworkPermission(options, normalizedHost, port);
    pendingApprovals.set(normalizedHost, decision);
    try {
      return await decision;
    } finally {
      pendingApprovals.delete(normalizedHost);
    }
  };
}

async function resolveNetworkPermission(
  options: NetworkPermissionOptions,
  host: string,
  port?: number,
): Promise<boolean> {
  try {
    const initialConfig = options.getRuntimeConfig();
    if (!initialConfig) return false;

    if (matchesDomainList(host, initialConfig.network.deniedDomains)) {
      recordNetworkEvent(options, "blocked", "explicit-deny-domain", host, port);
      return false;
    }
    if (matchesDomainList(host, initialConfig.network.allowedDomains)) return true;

    const suggestedCommand = buildNetworkBlockCommand("missing-allowed-domain", host);
    if (options.getPromptMode() === "non-interactive" || !options.canPrompt()) {
      recordNetworkEvent(options, "blocked", "missing-allowed-domain", host, port);
      options.notify(
        `Sandbox blocked network access to ${host}. To temporarily allow for this session, run: ${suggestedCommand}`,
        "warning",
      );
      return false;
    }

    const approved = await options.requestApproval({
      host,
      port,
      target: port ? `${host}:${port}` : host,
      suggestedCommand,
    });
    if (!approved) {
      recordNetworkEvent(options, "blocked", "missing-allowed-domain", host, port);
      return false;
    }

    const latestConfig = options.getRuntimeConfig();
    if (!latestConfig) return false;
    if (matchesDomainList(host, latestConfig.network.deniedDomains)) {
      recordNetworkEvent(options, "blocked", "explicit-deny-domain", host, port);
      options.notify(
        `Network access to ${host} remains denied by current sandbox policy. Remove it from deny list to allow.`,
        "warning",
      );
      return false;
    }
    if (matchesDomainList(host, latestConfig.network.allowedDomains)) {
      recordNetworkEvent(options, "allowed", "missing-allowed-domain", host, port);
      return true;
    }

    const nextConfig = structuredClone(latestConfig);
    nextConfig.network.allowedDomains.push(host);
    options.applyRuntimeConfig(nextConfig);
    recordNetworkEvent(options, "allowed", "missing-allowed-domain", host, port);
    options.notify(`Allowed network domain for this session: ${host}`, "info");
    return true;
  } catch (error) {
    options.notify(
      `Sandbox permission prompt failed for ${host}: ${error instanceof Error ? error.message : error}`,
      "warning",
    );
    return false;
  }
}

function recordNetworkEvent(
  options: NetworkPermissionOptions,
  outcome: SandboxEventOutcome,
  reason: NetworkEventReason,
  host: string,
  port?: number,
): void {
  options.recordEvent({
    timestamp: options.now?.() ?? Date.now(),
    kind: "network",
    outcome,
    reason,
    target: port ? `${host}:${port}` : host,
    cwd: options.getCwd(),
    summary: describeNetworkEventSummary(reason, outcome),
    suggestedCommand: outcome === "blocked" ? buildNetworkBlockCommand(reason, host) : undefined,
  });
}

function buildNetworkBlockCommand(reason: NetworkEventReason, host: string): string {
  const list = reason === "explicit-deny-domain" ? "deny remove" : "allow add";
  return `/sandbox network ${list} ${escapeSlashCommandArg(host)}`;
}

function describeNetworkEventSummary(
  reason: NetworkEventReason,
  outcome: SandboxEventOutcome,
): string {
  if (outcome === "allowed") return "user allowed network domain for this session";
  if (reason === "explicit-deny-domain") return "network access matched a deny list entry";
  return "network access target is not in the allowed domain list";
}

function matchesDomainList(host: string, rules: string[]): boolean {
  return rules.some((rule) => matchesDomainRule(host, rule));
}

function matchesDomainRule(host: string, rule: string): boolean {
  const normalizedRule = rule.toLowerCase();
  if (normalizedRule === "*") return true;
  if (!normalizedRule.startsWith("*.")) return host === normalizedRule;

  const suffix = normalizedRule.slice(1);
  return host.length > suffix.length && host.endsWith(suffix);
}

function escapeSlashCommandArg(value: string): string {
  if (/^[a-zA-Z0-9_./:@%+\-~]+$/.test(value)) return value;
  return JSON.stringify(value);
}
