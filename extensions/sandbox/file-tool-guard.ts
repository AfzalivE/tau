import { lstat, readlink } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { containsGlobChars } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import {
  inferSandboxRuleMatch,
  normalizeSandboxPath,
  resolveSandboxPath,
} from "./utils.ts";

export type FileToolAccessKind = "read" | "write";
export type FileToolReadAccess = "metadata" | "data";

export interface FileToolAccess {
  kind: FileToolAccessKind;
  path: string;
  readAccess?: FileToolReadAccess;
  traverses?: boolean;
}

export type FileToolPolicyViolationReason =
  | "explicit-deny-read"
  | "explicit-deny-write"
  | "missing-allow-write";

export interface FileToolPolicyViolation {
  access: FileToolAccess;
  reason: FileToolPolicyViolationReason;
  matchedRule?: string;
}

const MAX_SYMLINK_RESOLUTION_DEPTH = 40;

const FILE_TOOL_ACCESS: Record<
  string,
  { kind: FileToolAccessKind; readAccess?: FileToolReadAccess; traverses?: boolean }[]
> = {
  read: [{ kind: "read", readAccess: "data" }],
  write: [{ kind: "write" }],
  edit: [{ kind: "read", readAccess: "data" }, { kind: "write" }],
  // These tools may access descendants; ls stats every direct child to classify directories.
  grep: [{ kind: "read", readAccess: "data", traverses: true }],
  find: [{ kind: "read", readAccess: "metadata", traverses: true }],
  ls: [{ kind: "read", readAccess: "metadata", traverses: true }],
};

const OPTIONAL_PATH_TOOLS = new Set(["grep", "find", "ls"]);

/**
 * Returns the filesystem accesses a built-in file tool would make, or null for
 * tools outside the guard's scope. Paths are lexical; use
 * resolveFileToolAccesses() before enforcing a policy when symlinks matter.
 */
export function getFileToolAccesses(
  toolName: string,
  input: unknown,
  cwd: string,
): FileToolAccess[] | null {
  const accessTemplate = FILE_TOOL_ACCESS[toolName];
  if (!accessTemplate) return null;

  const path = getToolPath(input, OPTIONAL_PATH_TOOLS.has(toolName) ? "." : undefined);
  if (!path) return null;

  const resolvedPath = resolveSandboxPath(path, cwd);
  return accessTemplate.map((access) => ({ ...access, path: resolvedPath }));
}

/**
 * Resolves a file tool's paths through symlinked ancestors. This catches paths
 * such as workspace/link/secret where link points outside the workspace.
 */
export async function resolveFileToolAccesses(
  toolName: string,
  input: unknown,
  cwd: string,
): Promise<FileToolAccess[] | null> {
  const accesses = getFileToolAccesses(toolName, input, cwd);
  if (!accesses) return null;

  const resolvedPaths = new Map<string, Promise<string>>();
  return Promise.all(
    accesses.map(async (access) => {
      let canonicalPath = resolvedPaths.get(access.path);
      if (!canonicalPath) {
        canonicalPath = resolvePathThroughSymlinks(access.path);
        resolvedPaths.set(access.path, canonicalPath);
      }
      return { ...access, path: await canonicalPath };
    }),
  );
}

/**
 * Finds the first access that conflicts with sandbox filesystem policy.
 * Reads are allowed unless denied, with allowRead taking precedence. Writes
 * require allowWrite and are denied when denyWrite also matches.
 */
export function findFileToolPolicyViolation(
  accesses: FileToolAccess[] | null,
  runtimeConfig: SandboxRuntimeConfig,
  cwd: string,
): FileToolPolicyViolation | null {
  if (!accesses) return null;

  for (const access of accesses) {
    if (access.kind === "read") {
      const readAllowed =
        inferSandboxRuleMatch(access.path, runtimeConfig.filesystem.allowRead ?? [], cwd) !== null;
      const readDenied = inferSandboxRuleMatch(access.path, runtimeConfig.filesystem.denyRead, cwd);
      if (readDenied && !readAllowed) {
        return { access, reason: "explicit-deny-read", matchedRule: readDenied };
      }

      const traversalRule = access.traverses
        ? findDeniedTraversalRule(access.path, runtimeConfig, cwd)
        : null;
      if (traversalRule) {
        return { access, reason: "explicit-deny-read", matchedRule: traversalRule };
      }
      continue;
    }

    const deniedWrite = inferSandboxRuleMatch(access.path, runtimeConfig.filesystem.denyWrite, cwd);
    if (deniedWrite) {
      return { access, reason: "explicit-deny-write", matchedRule: deniedWrite };
    }
    if (inferSandboxRuleMatch(access.path, runtimeConfig.filesystem.allowWrite, cwd) === null) {
      return { access, reason: "missing-allow-write" };
    }
  }

  return null;
}

export interface FileToolGuardApproval {
  allow: boolean;
  reason?: string;
}

export interface FileToolGuardOptions {
  toolName: string;
  input: unknown;
  cwd: string;
  getRuntimeConfig: () => SandboxRuntimeConfig | null;
  onViolation: (violation: FileToolPolicyViolation) => Promise<FileToolGuardApproval>;
  inactiveReason?: string;
}

export interface FileToolGuardBlock {
  block: true;
  reason: string;
}

/**
 * Applies the sandbox filesystem policy to a native Pi file-tool call. The
 * caller owns prompting and session config updates through onViolation().
 */
export async function guardFileToolCall(
  options: FileToolGuardOptions,
): Promise<FileToolGuardBlock | null> {
  const lexicalAccesses = getFileToolAccesses(options.toolName, options.input, options.cwd);
  if (!lexicalAccesses) return null;

  const lexicalBlock = await guardFileToolAccesses(lexicalAccesses, options);
  if (lexicalBlock) return lexicalBlock;

  let canonicalAccesses: FileToolAccess[] | null;
  try {
    canonicalAccesses = await resolveFileToolAccesses(options.toolName, options.input, options.cwd);
  } catch (error) {
    return {
      block: true,
      reason: `Sandbox could not resolve the file-tool path: ${error instanceof Error ? error.message : error}`,
    };
  }

  return canonicalAccesses ? guardFileToolAccesses(canonicalAccesses, options) : null;
}

async function guardFileToolAccesses(
  accesses: FileToolAccess[],
  options: FileToolGuardOptions,
): Promise<FileToolGuardBlock | null> {
  for (const access of accesses) {
    let approvalAttempts = 0;
    while (true) {
      const runtimeConfig = options.getRuntimeConfig();
      if (!runtimeConfig) {
        return {
          block: true,
          reason:
            options.inactiveReason ??
            "Sandbox is no longer active and native file-tool execution is blocked. Re-enable the sandbox before retrying.",
        };
      }

      const policyViolation = findFileToolPolicyViolation([access], runtimeConfig, options.cwd);
      if (!policyViolation) break;

      if (approvalAttempts > 0) {
        return {
          block: true,
          reason: `Sandbox could not apply the filesystem permission for ${access.path}.`,
        };
      }
      approvalAttempts += 1;

      const approval = await options.onViolation(policyViolation);
      if (approval.allow) continue;
      return {
        block: true,
        reason: approval.reason ?? `Sandbox blocked filesystem access to ${access.path}.`,
      };
    }
  }

  return null;
}

function findDeniedTraversalRule(
  searchPath: string,
  runtimeConfig: SandboxRuntimeConfig,
  cwd: string,
): string | null {
  const allowRead = runtimeConfig.filesystem.allowRead ?? [];
  const normalizedSearchPath = normalizeSandboxPath(searchPath);

  for (const rule of runtimeConfig.filesystem.denyRead) {
    const ruleRoot = getRuleTraversalRoot(rule, cwd);
    if (!pathsOverlap(normalizedSearchPath, ruleRoot)) continue;
    if (inferSandboxRuleMatch(searchPath, allowRead, cwd)) continue;
    if (inferSandboxRuleMatch(ruleRoot, allowRead, cwd)) continue;
    return rule;
  }

  return null;
}

function getRuleTraversalRoot(rule: string, cwd: string): string {
  if (!containsGlobChars(rule)) return normalizeSandboxPath(rule, cwd);

  const firstGlobIndex = rule.search(/[?*[]/);
  const literalPrefix = firstGlobIndex === -1 ? "" : rule.slice(0, firstGlobIndex);
  const pathPrefix = literalPrefix.endsWith("/")
    ? literalPrefix.slice(0, -1)
    : dirname(literalPrefix);
  return normalizeSandboxPath(pathPrefix || ".", cwd);
}

function pathsOverlap(left: string, right: string): boolean {
  return isSameOrDescendant(left, right) || isSameOrDescendant(right, left);
}

function isSameOrDescendant(path: string, ancestor: string): boolean {
  if (path === ancestor) return true;
  const prefix = ancestor.endsWith("/") ? ancestor : `${ancestor}/`;
  return path.startsWith(prefix);
}

function getToolPath(input: unknown, defaultPath?: string): string | undefined {
  if (!input || typeof input !== "object") return defaultPath;

  const path = (input as { path?: unknown }).path;
  if (typeof path !== "string" || path.length === 0) return defaultPath;
  return path;
}

async function resolvePathThroughSymlinks(path: string, depth = 0): Promise<string> {
  if (depth > MAX_SYMLINK_RESOLUTION_DEPTH) {
    throw new Error(`Too many symbolic links while resolving ${path}`);
  }

  const root = parse(path).root;
  const segments = path.slice(root.length).split(sep).filter(Boolean);
  let currentPath = root;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const nextPath = join(currentPath, segment);

    let stat;
    try {
      stat = await lstat(nextPath);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      return resolve(currentPath, ...segments.slice(index));
    }

    if (!stat.isSymbolicLink()) {
      currentPath = nextPath;
      continue;
    }

    const target = await readlink(nextPath);
    const targetPath = isAbsolute(target) ? target : resolve(dirname(nextPath), target);
    return resolvePathThroughSymlinks(resolve(targetPath, ...segments.slice(index + 1)), depth + 1);
  }

  return currentPath;
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
