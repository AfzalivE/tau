import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  cloneRuntimeConfig,
  escapeSlashCommandArg,
  mutateStringList,
  type ListOp,
  type PromptMode,
} from "../config.js";
import { inferExactSandboxRuleMatch, inferSandboxRuleMatch } from "../utils.js";
import type {
  SandboxEvent,
  SandboxEventOutcome,
  SandboxEventReason,
  SandboxRuntime,
} from "../runtime.js";
import { findFileToolPolicyViolation } from "../file-tool-guard.js";
import {
  createPermissionResolution,
  showPermissionDialog,
  type PermissionResolution,
} from "./dialog.js";

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
  matchedRule?: string;
}

export type FilesystemList = "deny-read" | "allow-write" | "deny-write";

function extractSandboxViolationLines(output: string): string[] {
  // sandbox-runtime annotateStderrWithSandboxFailures wraps violations in this tag.
  const match = output.match(/<sandbox_violations>([\s\S]*?)<\/sandbox_violations>/i);
  if (!match?.[1]) return [];

  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function stripSandboxViolationAnnotations(text: string): string {
  return text
    .replace(/\n?<sandbox_violations>[\s\S]*?<\/sandbox_violations>\n?/gi, "\n")
    .replace(/^\n+|\n+$/g, "");
}

export function extractAppendedSandboxAnnotation(original: string, annotated: string): string {
  if (annotated === original) return "";

  if (annotated.startsWith(original)) {
    return stripSandboxViolationAnnotations(annotated.slice(original.length));
  }

  const violationLines = extractSandboxViolationLines(annotated);
  if (violationLines.length === 0) return "";

  // Sandbox violations are summarized elsewhere via compact extension messages,
  // so suppress the verbose synthetic annotation block.
  return "";
}

function sanitizeExtractedPath(path: string): string | undefined {
  const trimmed = path.trim();
  if (!trimmed) return undefined;

  const withoutDelimiter = trimmed.replace(/:+$/g, "");
  return withoutDelimiter.length > 0 ? withoutDelimiter : undefined;
}

function extractFilesystemErrorPath(line: string): string | undefined {
  // Raw output must identify the denied target, not merely mention an error and some path.
  const nodeError = line.match(
    /^(?:Error:\s+)?EPERM:\s+operation not permitted,\s+(?:open|scandir|mkdir|rmdir|unlink|stat|lstat|access|chmod|chown|readlink|realpath|opendir)\s+(["'])((?:~\/|\/).+)\1$/i,
  );
  if (nodeError?.[2]) return sanitizeExtractedPath(nodeError[2]);

  const shellError = line.match(/^(?:[^:\n]+:\s+)*((?:~\/|\/).+?):\s+Operation not permitted$/i);
  return shellError?.[1] ? sanitizeExtractedPath(shellError[1]) : undefined;
}

function extractViolationProcessName(line: string): string | undefined {
  const match = line.match(/^([^\s(]+)\(/);
  const processName = match?.[1]?.trim();
  if (!processName) return undefined;
  return processName.split("/").pop() || processName;
}

export function detectFilesystemViolationFromLine(line: string): FilesystemViolation | null {
  // Runtime emits concrete op variants (e.g. file-write-create/unlink, file-read-data).
  const lower = line.toLowerCase();
  const match = line.match(/\bfile-(?:read|write)[^\s]*\s+((?:~\/|\/).+)$/i);
  const path = match?.[1] ? sanitizeExtractedPath(match[1]) : undefined;
  const processName = extractViolationProcessName(line);

  if (lower.includes("file-write-unlink")) {
    return { kind: "write", path, processName, writeAccess: "unlink" };
  }

  if (lower.includes("file-write")) {
    return { kind: "write", path, processName, writeAccess: "unknown" };
  }

  if (lower.includes("file-read-metadata")) {
    return { kind: "read", path, processName, readAccess: "metadata" };
  }

  if (lower.includes("file-read-data")) {
    return { kind: "read", path, processName, readAccess: "data" };
  }

  if (lower.includes("file-read")) {
    return { kind: "read", path, processName, readAccess: "unknown" };
  }

  return null;
}

function detectFilesystemViolations(
  output: string,
  fallbackOutput: string = output,
  allowOutputFallback = true,
): FilesystemViolation[] {
  const violations: FilesystemViolation[] = [];
  const violationLines = extractSandboxViolationLines(output);

  for (let index = violationLines.length - 1; index >= 0; index -= 1) {
    const violation = detectFilesystemViolationFromLine(violationLines[index]);
    if (violation) violations.push(violation);
  }

  if (violations.length > 0 || !allowOutputFallback) return violations;

  for (const line of fallbackOutput.split("\n").reverse()) {
    const path = extractFilesystemErrorPath(line.trim());
    if (path) {
      violations.push({ kind: "unknown", path });
      break;
    }
  }

  return violations;
}

export function isTraversalViolation(
  runtimeConfig: SandboxRuntimeConfig | null,
  violation: FilesystemViolation,
  cwd?: string,
): boolean {
  if (!runtimeConfig || !violation.path) return false;
  if (!READ_TRAVERSAL_PROCESSES.has(violation.processName ?? "")) return false;

  if (violation.kind === "read") {
    return inferSandboxRuleMatch(violation.path, runtimeConfig.filesystem.denyRead, cwd) !== null;
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
  runtimeConfig: SandboxRuntimeConfig | null;
  output: string;
  cwd?: string;
}): string[] | null {
  const { runtimeConfig, output, cwd } = options;
  if (!runtimeConfig) return null;

  const violationLines = extractSandboxViolationLines(output);
  if (violationLines.length === 0) return null;

  const skippedPaths: string[] = [];
  for (const line of violationLines) {
    const violation = detectFilesystemViolationFromLine(line);
    if (!violation || !isTraversalViolation(runtimeConfig, violation, cwd)) {
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

interface FilesystemAllowAction {
  list: FilesystemList;
  op: ListOp;
  value: string;
}

function buildFilesystemAllowAction(
  runtimeConfig: SandboxRuntimeConfig,
  violation: FilesystemViolation,
  cwd?: string,
): FilesystemAllowAction | null {
  if (!violation.path) return null;

  if (violation.kind === "read") {
    const matchedRule =
      violation.matchedRule ??
      inferSandboxRuleMatch(violation.path, runtimeConfig.filesystem.denyRead, cwd);
    return { list: "deny-read", op: "remove", value: matchedRule ?? violation.path };
  }

  if (violation.kind === "write") {
    const matchedDeny =
      violation.matchedRule ??
      inferSandboxRuleMatch(violation.path, runtimeConfig.filesystem.denyWrite, cwd);
    if (matchedDeny) {
      return { list: "deny-write", op: "remove", value: matchedDeny };
    }

    return { list: "allow-write", op: "add", value: violation.path };
  }

  const matchedDenyWrite = inferSandboxRuleMatch(
    violation.path,
    runtimeConfig.filesystem.denyWrite,
    cwd,
  );
  if (matchedDenyWrite) {
    return { list: "deny-write", op: "remove", value: matchedDenyWrite };
  }

  const matchedDenyRead = inferSandboxRuleMatch(
    violation.path,
    runtimeConfig.filesystem.denyRead,
    cwd,
  );
  if (matchedDenyRead) {
    return { list: "deny-read", op: "remove", value: matchedDenyRead };
  }

  return { list: "allow-write", op: "add", value: violation.path };
}

function buildFilesystemAllowCommand(action: FilesystemAllowAction): string {
  return `/sandbox filesystem ${action.list} ${action.op} ${escapeSlashCommandArg(action.value)}`;
}

function getFilesystemListValues(
  runtimeConfig: SandboxRuntimeConfig,
  list: FilesystemList,
): string[] {
  if (list === "deny-read") return runtimeConfig.filesystem.denyRead;
  if (list === "allow-write") return runtimeConfig.filesystem.allowWrite;
  return runtimeConfig.filesystem.denyWrite;
}

function applyFilesystemAllowAction(
  runtimeConfig: SandboxRuntimeConfig,
  action: FilesystemAllowAction,
): boolean {
  const values = getFilesystemListValues(runtimeConfig, action.list);
  return mutateStringList(values, action.op, action.value);
}

function isFilesystemAllowActionAlreadyApplied(
  runtimeConfig: SandboxRuntimeConfig,
  action: FilesystemAllowAction,
): boolean {
  const values = getFilesystemListValues(runtimeConfig, action.list);
  return action.op === "add" ? values.includes(action.value) : !values.includes(action.value);
}

function describeFilesystemViolationTarget(violation: FilesystemViolation): string {
  if (violation.kind === "read") {
    if (violation.path) return `read from ${violation.path}`;
    return "read";
  }

  if (violation.kind === "write") {
    if (violation.path) return `write to ${violation.path}`;
    return "write";
  }

  if (violation.path) return `access to ${violation.path}`;
  return "access";
}

function formatFilesystemViolationSummary(violation: FilesystemViolation): string {
  if (violation.kind === "read") {
    if (violation.path) return `[sandbox] Blocked filesystem read: ${violation.path}`;
    return "[sandbox] Blocked filesystem read.";
  }

  if (violation.kind === "write") {
    if (violation.path) return `[sandbox] Blocked filesystem write: ${violation.path}`;
    return "[sandbox] Blocked filesystem write.";
  }

  if (violation.path) return `[sandbox] Blocked filesystem access: ${violation.path}`;
  return "[sandbox] Blocked filesystem access (EPERM).";
}

function classifyFilesystemEventReason(
  runtimeConfig: SandboxRuntimeConfig,
  violation: FilesystemViolation,
  cwd?: string,
  alreadyApproved = false,
): SandboxEventReason {
  if (alreadyApproved) return "already-approved-still-failed";

  if (violation.path) {
    if (inferSandboxRuleMatch(violation.path, runtimeConfig.filesystem.denyWrite, cwd)) {
      return "explicit-deny-write";
    }
    if (inferSandboxRuleMatch(violation.path, runtimeConfig.filesystem.denyRead, cwd)) {
      return "explicit-deny-read";
    }
  }

  if (violation.kind === "write" || violation.kind === "unknown") return "missing-allow-write";
  return "unknown";
}

function describeFilesystemEventSummary(
  reason: SandboxEventReason,
  violation: FilesystemViolation,
  outcome: SandboxEventOutcome,
): string {
  if (outcome === "allowed") {
    if (reason === "explicit-deny-read") return "user allowed filesystem read for this session";
    if (reason === "explicit-deny-write") return "user allowed filesystem write for this session";
    if (reason === "missing-allow-write") {
      return violation.kind === "unknown"
        ? "user allowed filesystem access for this session"
        : "user allowed filesystem write path for this session";
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
    return violation.kind === "unknown"
      ? "filesystem access fell outside the current allow-write paths"
      : "filesystem write fell outside the current allow-write paths";
  }
  return "sandbox blocked filesystem access";
}

function formatFilesystemBlockedTarget(target: string): string {
  return `Sandbox blocked filesystem ${target}.`;
}

export async function handleFilesystemViolation(options: {
  ctx: ExtensionContext | null;
  promptMode: PromptMode;
  runtimeConfig: SandboxRuntimeConfig;
  getRuntimeConfig: () => SandboxRuntimeConfig | null;
  output: string;
  rawOutput: string;
  explicitViolation?: FilesystemViolation;
  command: string;
  cwd?: string;
  pendingDialogs?: Map<string, Promise<PermissionResolution | null>>;
  applyRuntimeConfigForSession?: (
    ctx: ExtensionContext,
    runtimeConfig: SandboxRuntimeConfig,
  ) => void;
  savePermission?: SandboxRuntime["savePermission"];
  recordEvent?: (event: SandboxEvent) => void;
  autoRetryAvailable?: boolean;
  runtimeProtectedWriteViolations?: FilesystemViolation[];
  allowOutputFallback?: boolean;
}): Promise<PermissionResolution | null> {
  const {
    ctx,
    promptMode,
    runtimeConfig,
    getRuntimeConfig,
    output,
    rawOutput,
    explicitViolation,
    command,
    cwd,
    pendingDialogs,
    applyRuntimeConfigForSession,
    savePermission,
    recordEvent,
    autoRetryAvailable = true,
    runtimeProtectedWriteViolations = [],
    allowOutputFallback = true,
  } = options;
  const violations = explicitViolation
    ? [explicitViolation]
    : detectFilesystemViolations(output, rawOutput, allowOutputFallback);
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
      if (!candidateAction) return false;
      return !isFilesystemAllowActionAlreadyApplied(runtimeConfig, candidateAction);
    }) ?? actionableViolations[0];

  const summary = formatFilesystemViolationSummary(violation);
  const target = describeFilesystemViolationTarget(violation);
  const blockedTarget = formatFilesystemBlockedTarget(target);
  const allowAction = buildFilesystemAllowAction(runtimeConfig, violation, cwd);
  const allowCommand = allowAction ? buildFilesystemAllowCommand(allowAction) : null;
  const alreadyApproved = allowAction
    ? isFilesystemAllowActionAlreadyApplied(runtimeConfig, allowAction)
    : false;
  const eventReason = classifyFilesystemEventReason(runtimeConfig, violation, cwd, alreadyApproved);
  const blockedSuggestedCommand = alreadyApproved ? undefined : (allowCommand ?? undefined);

  const recordFilesystemEvent = (outcome: SandboxEventOutcome, saved = false): void => {
    recordEvent?.({
      timestamp: Date.now(),
      kind: "filesystem",
      outcome,
      reason: eventReason,
      target: violation.path,
      command,
      cwd,
      summary: saved
        ? "user allowed filesystem access globally"
        : describeFilesystemEventSummary(eventReason, violation, outcome),
      suggestedCommand: outcome === "blocked" ? blockedSuggestedCommand : undefined,
    });
  };

  if (promptMode === "non-interactive" || !ctx?.hasUI) {
    recordFilesystemEvent("blocked");
    if (!allowCommand) return { kind: "deny", message: summary };
    return {
      kind: "deny",
      message: `${summary}\n[sandbox] To temporarily allow for this session, run: ${allowCommand}`,
    };
  }

  if (!allowAction || !allowCommand) {
    recordFilesystemEvent("blocked");
    return { kind: "deny", message: summary };
  }

  if (alreadyApproved) {
    recordFilesystemEvent("blocked");
    return createPermissionResolution("allow-adapt", blockedTarget, false);
  }

  const access = violation.kind === "read" || allowAction.list === "deny-read" ? "read" : "write";
  const promptKey = `${allowCommand}:${autoRetryAvailable ? "retry" : "adapt"}`;
  return showPermissionDialog({
    ctx,
    prompt: {
      request:
        violation.readAccess === "metadata"
          ? "Filesystem metadata read"
          : `Filesystem ${violation.kind === "unknown" ? "access" : violation.kind}`,
      target: violation.path!,
      requester: violation.processName,
      command,
      typeCode:
        violation.kind === "write"
          ? "FS_WRITE"
          : violation.readAccess === "metadata"
            ? "FS_META"
            : violation.kind === "read"
              ? "FS_READ"
              : "FS_ACCESS",
    },
    promptKey,
    pendingDialogs,
    autoRetryAvailable,
    canSave: Boolean(savePermission),
    async onDecision(decision) {
      if (decision === "deny") {
        recordFilesystemEvent("blocked");
        return createPermissionResolution(decision, blockedTarget);
      }

      if (decision === "allow-always") {
        const current = getRuntimeConfig();
        if (!current) return createPermissionResolution("deny", blockedTarget);
        const proposed = cloneRuntimeConfig(current);
        applyFilesystemAllowAction(proposed, allowAction);
        if (
          findFileToolPolicyViolation(
            [{ kind: access, path: violation.path! }],
            proposed,
            cwd ?? ctx.cwd,
          )
        ) {
          recordFilesystemEvent("blocked");
          return {
            kind: "deny",
            message: `${blockedTarget}\nCurrent policy still blocks this path. No global approval was saved.`,
          };
        }
        const list =
          allowAction.list === "deny-read"
            ? "denyRead"
            : allowAction.list === "deny-write"
              ? "denyWrite"
              : "allowWrite";
        if (
          !(await savePermission?.(ctx, {
            section: "filesystem",
            list,
            op: allowAction.op,
            value: allowAction.value,
            target: violation.path!,
            access,
          }))
        ) {
          recordFilesystemEvent("blocked");
          return createPermissionResolution("deny", blockedTarget);
        }
      }

      const latestConfig = getRuntimeConfig();
      if (!latestConfig) {
        recordFilesystemEvent("blocked");
        return createPermissionResolution("deny", blockedTarget);
      }

      // Preserve policy edits made during the dialog, applying only the original exception.
      const nextConfig = cloneRuntimeConfig(latestConfig);
      const changed = applyFilesystemAllowAction(nextConfig, allowAction);
      if (
        decision === "allow-always" &&
        findFileToolPolicyViolation(
          [{ kind: access, path: violation.path! }],
          nextConfig,
          cwd ?? ctx.cwd,
        )
      ) {
        recordFilesystemEvent("blocked");
        return {
          kind: "deny",
          message: `${blockedTarget}\nPermission saved globally, but current policy still blocks this path. The command was not retried.`,
        };
      }
      if (changed) {
        applyRuntimeConfigForSession?.(ctx, nextConfig);
      }

      recordFilesystemEvent("allowed", decision === "allow-always");
      return createPermissionResolution(decision, blockedTarget, changed);
    },
  });
}
