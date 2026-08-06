import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { isSandboxWritablePath } from "./utils.ts";

export interface RuntimeWriteViolation {
  kind: "read" | "write" | "unknown";
  path?: string;
}

export function isRuntimeProtectedWriteViolation(
  runtimeConfig: SandboxRuntimeConfig | null,
  violation: RuntimeWriteViolation,
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

export function getRuntimeProtectedWriteViolations<T extends RuntimeWriteViolation>(
  runtimeConfig: SandboxRuntimeConfig | null,
  violations: T[],
  cwd?: string,
): T[] {
  const violationsByPath = new Map<string, T>();

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
