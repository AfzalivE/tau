import {
  cloneRuntimeConfig,
  mutateStringList,
  type ListOp,
  type SandboxPolicy,
} from "../config.js";
import type { SandboxEventReason } from "../runtime.js";
import type { PermissionProposal } from "./proposal.js";

export interface MachLookupViolation {
  service: string;
}

export function proposeMachLookupPermission(options: {
  runtimeConfig: SandboxPolicy;
  violations: MachLookupViolation[];
  command: string;
  cwd: string;
  rawOutput: string;
  autoRetryAvailable: boolean;
  automaticReviewAvailable: boolean;
}): PermissionProposal | null {
  const {
    runtimeConfig,
    violations,
    command,
    cwd,
    rawOutput,
    autoRetryAvailable,
    automaticReviewAvailable,
  } = options;
  if (violations.length === 0) return null;

  const violation =
    violations.find((candidate) => !isMachLookupAlreadyAllowed(runtimeConfig, candidate.service)) ??
    violations[0];
  const { service } = violation;
  const alreadyApplied = isMachLookupAlreadyAllowed(runtimeConfig, service);
  const reason: SandboxEventReason = alreadyApplied
    ? "already-approved-still-failed"
    : "missing-mach-lookup";
  const proposal: PermissionProposal = {
    kind: "mach-lookup",
    policy: runtimeConfig,
    target: service,
    command,
    cwd,
    operation: "lookup",
    reason,
    alreadyApplied,
    action: { list: "mach-lookup", op: "add", value: service },
    autoRetryAvailable,
  };

  if (
    process.platform === "darwin" &&
    autoRetryAvailable &&
    automaticReviewAvailable &&
    !alreadyApplied &&
    isLiteralMachLookupService(service)
  ) {
    const config = cloneRuntimeConfig(runtimeConfig);
    mutateMachLookupAllowList(config, "add", service);
    proposal.automatic = {
      config,
      permission: {
        scope: "one sandboxed retry and its descendants; not session policy",
        target: service,
        operation: "lookup",
        addAllowMachLookup: [service],
        diagnosticSource: "seatbelt-denial",
        diagnosticAuthority:
          "none; neither necessity nor authorization follows from this diagnostic",
        scopeWarning:
          "Service access can invoke operations beyond the process sandbox. The service name alone does not establish the request payload.",
      },
      evidence: rawOutput,
    };
  }
  return proposal;
}

function detectMachLookupViolationFromLine(line: string): MachLookupViolation | null {
  // Parse Seatbelt's operation field, never a denial-like suffix in a filesystem path.
  // Preserve the complete reported name. Ambiguous names stay manual.
  const match = line.match(/^[^\r\n(]+\(\d+\)\s+deny\(\d+\)\s+mach-lookup\s+([^\r\n]+)$/i);
  const service = match?.[1];
  return service ? { service } : null;
}

export function detectMachLookupViolations(lines: string[]): MachLookupViolation[] {
  const violationsByService = new Map<string, MachLookupViolation>();

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const violation = detectMachLookupViolationFromLine(lines[index]);
    if (violation && !violationsByService.has(violation.service)) {
      violationsByService.set(violation.service, violation);
    }
  }

  return Array.from(violationsByService.values());
}

export function isValidMachLookupRule(rule: string): boolean {
  const trimmed = rule.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;

  const prefix = trimmed.endsWith("*") ? trimmed.slice(0, -1) : trimmed;
  return !prefix.includes("*");
}

function matchesMachLookupRule(service: string, rule: string): boolean {
  if (rule === "*") return true;
  if (rule.endsWith("*")) return service.startsWith(rule.slice(0, -1));
  return service === rule;
}

export function mutateMachLookupAllowList(
  runtimeConfig: SandboxPolicy,
  op: ListOp,
  service: string,
): boolean {
  runtimeConfig.network.allowMachLookup ??= [];
  return mutateStringList(runtimeConfig.network.allowMachLookup, op, service);
}

function isMachLookupAlreadyAllowed(runtimeConfig: SandboxPolicy | null, service: string): boolean {
  return (runtimeConfig?.network.allowMachLookup ?? []).some((rule) =>
    matchesMachLookupRule(service, rule),
  );
}

function isLiteralMachLookupService(service: string): boolean {
  return service.length > 0 && !/[\s\\*?[\]{}()"'\p{C}]/u.test(service);
}
