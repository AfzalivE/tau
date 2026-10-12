import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { getDefaultWritePaths } from "@anthropic-ai/sandbox-runtime";
import { readRulesOf } from "@anthropic-ai/sandbox-runtime/dist/sandbox/path-entries.js";

import {
  cloneRuntimeConfig,
  getFilesystemListValues,
  inferExactSandboxRuleMatch,
  inferSandboxRuleMatch,
  isSandboxWritablePath,
  type SandboxPolicy,
} from "../config.js";
import type { SandboxEventReason } from "../runtime.js";
import type { PermissionProposal } from "./proposal.js";

const READ_TRAVERSAL_PROCESSES = new Set(["find", "ls", "fd", "fdfind"]);

type FilesystemViolationKind = "read" | "write" | "unknown";
type FilesystemReadAccess = "metadata" | "data" | "unknown";
type FilesystemWriteAccess = "unlink" | "unknown";

export interface FilesystemViolation {
  kind: FilesystemViolationKind;
  path?: string;
  processName?: string;
  readAccess?: FilesystemReadAccess;
  writeAccess?: FilesystemWriteAccess;
}

export function proposeFilesystemPermission(options: {
  runtimeConfig: SandboxPolicy;
  violations: FilesystemViolation[];
  diagnosticSource: "seatbelt-denial" | "linux-write-attempt" | "process-output";
  command: string;
  cwd: string;
  rawOutput: string;
  autoRetryAvailable: boolean;
  automaticReviewAvailable: boolean;
  runtimeProtectedWriteViolations: FilesystemViolation[];
}): PermissionProposal | null {
  const {
    runtimeConfig,
    violations,
    diagnosticSource,
    command,
    cwd,
    rawOutput,
    autoRetryAvailable,
    automaticReviewAvailable,
    runtimeProtectedWriteViolations,
  } = options;
  const runtimeProtectedWritePaths = new Set(
    runtimeProtectedWriteViolations.map((violation) => violation.path).filter(Boolean),
  );
  const actionableViolations = violations.filter((violation) => {
    const isRuntimeProtectedWrite =
      violation.kind !== "read" && runtimeProtectedWritePaths.has(violation.path);
    return !isRuntimeProtectedWrite && !isTraversalViolation(runtimeConfig, violation, cwd);
  });
  if (actionableViolations.length === 0) return null;

  const violation =
    actionableViolations.find((candidate) => {
      const candidateAction = buildFilesystemAllowAction(runtimeConfig, candidate, cwd);
      return (
        candidateAction !== null &&
        !isFilesystemAllowActionAlreadyApplied(runtimeConfig, candidateAction)
      );
    }) ?? actionableViolations[0];
  const action = buildFilesystemAllowAction(runtimeConfig, violation, cwd);
  if (!action || !violation.path) return null;

  const alreadyApplied = isFilesystemAllowActionAlreadyApplied(runtimeConfig, action);
  const reason = classifyFilesystemEventReason(runtimeConfig, violation, cwd, alreadyApplied);
  const proposal: PermissionProposal = {
    kind: "filesystem",
    policy: runtimeConfig,
    target: violation.path,
    command,
    cwd,
    operation: violation.kind,
    reason,
    alreadyApplied,
    action,
    autoRetryAvailable,
  };

  // Diagnostics nominate a capability. They do not establish necessity or authorization.
  if (autoRetryAvailable && automaticReviewAvailable && !alreadyApplied) {
    const exception = prepareTemporaryException(runtimeConfig, violation, cwd);
    if (exception) {
      proposal.automatic = {
        config: exception.config,
        permission: {
          ...exception.permission,
          diagnosticSource,
          diagnosticAuthority:
            "none; neither necessity nor authorization follows from this diagnostic",
        },
        evidence: rawOutput,
      };
    }
  }
  return proposal;
}

export function isRuntimeProtectedWriteViolation(
  runtimeConfig: SandboxPolicy | null,
  violation: FilesystemViolation,
  cwd?: string,
): boolean {
  if (
    !runtimeConfig ||
    runtimeConfig.filesystem.disabled ||
    !violation.path ||
    violation.kind !== "write"
  ) {
    return false;
  }

  return isSandboxWritablePath(runtimeConfig, violation.path, cwd);
}

export function getRuntimeProtectedWriteViolations(
  runtimeConfig: SandboxPolicy | null,
  violations: FilesystemViolation[],
  cwd?: string,
): FilesystemViolation[] {
  const violationsByPath = new Map<string, FilesystemViolation>();

  for (const violation of violations) {
    if (!isRuntimeProtectedWriteViolation(runtimeConfig, violation, cwd) || !violation.path) {
      continue;
    }
    if (!violationsByPath.has(violation.path)) {
      violationsByPath.set(violation.path, violation);
    }
  }

  return Array.from(violationsByPath.values());
}

function extractSandboxViolationLines(output: string): string[] {
  // sandbox-runtime annotateStderrWithSandboxFailures wraps violations in this tag.
  const match = output.match(/<sandbox_violations>([\s\S]*?)<\/sandbox_violations>/i);
  if (!match?.[1]) return [];

  return match[1].split("\n").filter((line) => line.trim().length > 0);
}

function stripSandboxViolationAnnotations(text: string): string {
  return text
    .replace(/\n?<sandbox_violations>[\s\S]*?<\/sandbox_violations>\n?/gi, "\n")
    .replace(/^\n+|\n+$/g, "");
}

export function extractAppendedSandboxAnnotation(original: string, annotated: string): string {
  if (!annotated.startsWith(original)) return "";

  // Only inspect appended text. User output, including violation-shaped text, stays intact.
  return stripSandboxViolationAnnotations(annotated.slice(original.length));
}

function extractFilesystemErrorPath(line: string): string | undefined {
  // Raw output must identify the denied target, not merely mention an error and some path.
  const nodeError = line.match(
    /^(?:Error:\s+)?EPERM:\s+operation not permitted,\s+(?:open|scandir|mkdir|rmdir|unlink|stat|lstat|access|chmod|chown|readlink|realpath|opendir)\s+(["'])((?:~\/|\/).+)\1$/i,
  );
  if (nodeError?.[2]) return nodeError[2];

  // Prefixes cannot consume a path containing ": /", and target bytes stay intact.
  const shellError = line.match(/^(?:[^/:\r\n]+:\s+)*((?:~\/|\/).+):\s+Operation not permitted$/i);
  return shellError?.[1];
}

function extractViolationProcessName(line: string): string | undefined {
  const match = line.match(/^([^\s(]+)\(/);
  const processName = match?.[1]?.trim();
  if (!processName) return undefined;
  return processName.split("/").pop() || processName;
}

export function detectFilesystemViolationFromLine(line: string): FilesystemViolation | null {
  // Linux's write-intent observer supplies diagnostic requests, not trustworthy denial
  // evidence. Parse the entire pathname instead of promoting operation-like suffixes.
  const linux = line.match(/^deny [a-z0-9_]+ (\/[^\r\n]*)$/i);
  if (linux) return { kind: "write", path: linux[1], writeAccess: "unknown" };

  // Parse Seatbelt's operation field, never an operation-looking substring in a filename.
  // Preserve received path bytes; the runtime may already have sanitized stored diagnostics.
  const match = line.match(
    /^[^\r\n(]+\(\d+\)\s+deny\(\d+\)\s+(file-(?:read|write)(?:-[a-z-]+)?)\s+(\/[^\r\n]*)$/i,
  );
  if (!match) return null;
  const lower = match[1].toLowerCase();
  const path = match[2];
  const processName = extractViolationProcessName(line);

  return lower.includes("file-write")
    ? {
        kind: "write",
        path,
        processName,
        writeAccess: lower.includes("file-write-unlink") ? "unlink" : "unknown",
      }
    : {
        kind: "read",
        path,
        processName,
        readAccess: lower.includes("file-read-metadata")
          ? "metadata"
          : lower.includes("file-read-data")
            ? "data"
            : "unknown",
      };
}

export function detectFilesystemViolations(
  output: string,
  allowOutputFallback = true,
): FilesystemViolation[] {
  const violations: FilesystemViolation[] = [];
  const violationLines = extractSandboxViolationLines(output);

  for (let index = violationLines.length - 1; index >= 0; index -= 1) {
    const violation = detectFilesystemViolationFromLine(violationLines[index]);
    if (violation) violations.push(violation);
  }

  if (violations.length > 0 || !allowOutputFallback) return violations;

  for (const line of output.split("\n").reverse()) {
    const path = extractFilesystemErrorPath(line);
    if (path) {
      violations.push({ kind: "unknown", path });
      break;
    }
  }

  return violations;
}

export function isTraversalViolation(
  runtimeConfig: SandboxPolicy | null,
  violation: FilesystemViolation,
  cwd?: string,
): boolean {
  if (!runtimeConfig || !violation.path) return false;
  if (!READ_TRAVERSAL_PROCESSES.has(violation.processName ?? "")) return false;

  if (violation.kind === "read") {
    return (
      inferSandboxRuleMatch(violation.path, runtimeConfig.filesystem.denyRead, "denyRead", cwd) !==
      null
    );
  }

  if (violation.kind !== "write" || violation.writeAccess !== "unlink") return false;

  // Seatbelt can emit file-write-unlink checks for protected directory roots
  // while traversal commands enumerate them. Only exact protected roots are
  // treated as skipped traversal so writes under protected trees still prompt.
  return (
    inferExactSandboxRuleMatch(violation.path, runtimeConfig.filesystem.denyRead, cwd) !== null ||
    inferExactSandboxRuleMatch(violation.path, runtimeConfig.filesystem.denyWrite, cwd) !== null
  );
}

export function getTraversalPaths(options: {
  runtimeConfig: SandboxPolicy | null;
  violations: FilesystemViolation[];
  cwd?: string;
}): string[] | null {
  const { runtimeConfig, violations, cwd } = options;
  if (!runtimeConfig || violations.length === 0) return null;

  const skippedPaths: string[] = [];
  for (const violation of violations) {
    if (!isTraversalViolation(runtimeConfig, violation, cwd)) {
      return null;
    }
    if (violation.path && !skippedPaths.includes(violation.path)) {
      skippedPaths.push(violation.path);
    }
  }

  return skippedPaths.length > 0 ? skippedPaths : null;
}

export function formatTraversalNotice(paths: string[]): string {
  if (paths.length === 0) return "";

  const visiblePaths = paths.slice(0, 3).join(", ");
  const suffix = paths.length > 3 ? ", ..." : "";
  const label = paths.length === 1 ? "path" : "paths";
  return `[sandbox] Continued after skipping protected ${label}: ${visiblePaths}${suffix}`;
}

export function formatRuntimeProtectedWriteNotice(
  violations: FilesystemViolation[],
  continued: boolean,
): string {
  const paths = violations
    .map((violation) => violation.path)
    .filter((path): path is string => path !== undefined);
  if (paths.length === 0) return "";

  const visiblePaths = paths.slice(0, 3).join(", ");
  const suffix = paths.length > 3 ? ", ..." : "";
  const label = paths.length === 1 ? "write" : "writes";
  const prefix = continued ? "Continued after blocking" : "Blocked";
  return `[sandbox] ${prefix} runtime-protected ${label} that sandbox config cannot override: ${visiblePaths}${suffix}`;
}

type FilesystemAllowAction = Extract<PermissionProposal, { kind: "filesystem" }>["action"];

function buildFilesystemAllowAction(
  runtimeConfig: SandboxPolicy,
  violation: FilesystemViolation,
  cwd?: string,
): FilesystemAllowAction | null {
  if (!violation.path) return null;

  if (violation.kind !== "read") {
    const matchedDeny = inferSandboxRuleMatch(
      violation.path,
      runtimeConfig.filesystem.denyWrite,
      "denyWrite",
      cwd,
    );
    if (matchedDeny) return { list: "deny-write", op: "remove", value: matchedDeny };
  }

  if (violation.kind !== "write") {
    const matchedDeny = inferSandboxRuleMatch(
      violation.path,
      runtimeConfig.filesystem.denyRead,
      "denyRead",
      cwd,
    );
    if (matchedDeny || violation.kind === "read") {
      return { list: "deny-read", op: "remove", value: matchedDeny ?? violation.path };
    }
  }

  return { list: "allow-write", op: "add", value: violation.path };
}

function isFilesystemAllowActionAlreadyApplied(
  runtimeConfig: SandboxPolicy,
  action: FilesystemAllowAction,
): boolean {
  const values = getFilesystemListValues(runtimeConfig, action.list);
  return action.op === "add" ? values.includes(action.value) : !values.includes(action.value);
}

function classifyFilesystemEventReason(
  runtimeConfig: SandboxPolicy,
  violation: FilesystemViolation,
  cwd?: string,
  alreadyApproved = false,
): SandboxEventReason {
  if (alreadyApproved) return "already-approved-still-failed";

  if (violation.path) {
    if (
      inferSandboxRuleMatch(violation.path, runtimeConfig.filesystem.denyWrite, "denyWrite", cwd)
    ) {
      return "explicit-deny-write";
    }
    if (inferSandboxRuleMatch(violation.path, runtimeConfig.filesystem.denyRead, "denyRead", cwd)) {
      return "explicit-deny-read";
    }
  }

  if (violation.kind === "write" || violation.kind === "unknown") return "missing-allow-write";
  return "unknown";
}

function prepareTemporaryException(
  policy: SandboxPolicy,
  violation: FilesystemViolation,
  cwd?: string,
): { config: SandboxPolicy; permission: Record<string, unknown> } | undefined {
  const target = violation.path;
  if (!target?.startsWith("/") || policy.filesystem.disabled) return undefined;
  // Output quoting can be ambiguous for escape/control sequences. Never normalize those
  // into an automatic proposal for a potentially different literal file.
  if (/[\\\p{C}]/u.test(target)) return undefined;
  const action = buildFilesystemAllowAction(policy, violation, cwd);
  if (!action) return undefined;
  const operation =
    violation.kind === "unknown"
      ? action.list === "deny-read"
        ? "read"
        : "write"
      : violation.kind;
  // Tau keeps string-only rules, which may also act as permission patterns.
  // Literal filenames containing glob metacharacters stay on the manual path.
  if (!inferExactSandboxRuleMatch(target, [target], cwd)) return undefined;
  const config = cloneRuntimeConfig(policy);
  const permission: Record<string, unknown> = {
    scope: "one sandboxed retry and its descendants; not session policy",
    target,
    operation,
    reportedOperation: violation.kind,
    operationBasis:
      violation.kind === "unknown"
        ? "candidate inferred from policy; the original operation is unknown"
        : "untrusted diagnostic claim",
  };
  if (operation === "read") {
    try {
      permission.targetScope = statSync(target).isDirectory() ? "directory subtree" : "file";
    } catch {
      return undefined;
    }
    config.filesystem.allowRead = [...(config.filesystem.allowRead ?? []), target];
    permission.addAllowRead = [target];
    permission.denyRead = policy.filesystem.denyRead;
  } else {
    const removedDenials = config.filesystem.denyWrite.filter(
      (rule) => inferSandboxRuleMatch(target, [rule], "denyWrite", cwd) !== null,
    );
    config.filesystem.denyWrite = config.filesystem.denyWrite.filter(
      (rule) => !removedDenials.includes(rule),
    );
    let writePath = target;
    // Linux bind mounts require an existing path. Disclose the parent grant needed for
    // creation instead of claiming that a new-file exception would be exact-file scoped.
    if (process.platform === "linux") {
      while (!existsSync(writePath)) {
        const parent = dirname(writePath);
        if (parent === writePath) return undefined;
        writePath = parent;
      }
    }
    const addWrite = !isSandboxWritablePath(config, writePath, cwd);
    if (addWrite) config.filesystem.allowWrite.push(writePath);
    permission.addAllowWrite = addWrite ? [writePath] : [];
    permission.removeDenyWrite = removedDenials;
    permission.scopeWarning =
      "Removing a deny relaxes the whole rule within writable roots: pattern matches, applicable literal-name and anchored-pattern readings, and their directory subtrees, not just the reported target. These readings depend on the filesystem when wrapping, not a frozen list of names. Directory write grants cover their subtrees.";
  }
  const originalDefaults = getDefaultWritePaths(
    readRulesOf(policy.filesystem.denyRead, policy.filesystem.allowRead, []),
  );
  const proposedDefaults = getDefaultWritePaths(
    readRulesOf(config.filesystem.denyRead, config.filesystem.allowRead, []),
  );
  permission.existingWriteRoots = [...originalDefaults, ...policy.filesystem.allowWrite];
  const restoredDefaults = proposedDefaults.filter((root) => !originalDefaults.includes(root));
  permission.restoredDefaultWriteRoots = restoredDefaults;
  if (operation === "read" && restoredDefaults.length > 0) {
    permission.scopeWarning =
      "This read exception also restores runtime-provided write access to the listed default directory subtrees.";
  }
  return { config, permission };
}
