import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import {
  containsGlobChars,
  globToRegex,
  normalizePathForSandbox,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Resolves a path using Pi-compatible @, Unicode-space, tilde, and file URL
 * handling before anchoring relative paths to cwd.
 */
export function resolveSandboxPath(value: string, cwd = process.cwd()): string {
  const withoutAtPrefix = value.replace(UNICODE_SPACES, " ").replace(/^@/, "");
  const expandedPath =
    withoutAtPrefix === "~"
      ? homedir()
      : withoutAtPrefix.startsWith("~/")
        ? join(homedir(), withoutAtPrefix.slice(2))
        : withoutAtPrefix.startsWith("file://")
          ? fileURLToPath(withoutAtPrefix)
          : withoutAtPrefix;
  return resolve(cwd, expandedPath);
}

export function normalizeSandboxPath(value: string, cwd?: string): string {
  let ancestor = resolveSandboxPath(value, cwd);
  const suffix: string[] = [];
  // SRT only resolves existing paths. Normalize the existing ancestor of new
  // targets too, so /tmp and /private/tmp spellings use the same policy rules.
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) {
    suffix.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  return join(normalizePathForSandbox(ancestor), ...suffix);
}

export function inferSandboxRuleMatch(path: string, rules: string[], cwd?: string): string | null {
  for (const rule of rules) {
    if (matchesSandboxRule(path, rule, cwd)) return rule;
  }
  return null;
}

export function inferExactSandboxRuleMatch(
  path: string,
  rules: string[],
  cwd?: string,
): string | null {
  for (const rule of rules) {
    if (containsGlobChars(rule)) continue;
    if (normalizeSandboxPath(path) === normalizeSandboxPath(rule, cwd)) return rule;
  }
  return null;
}

export function isSandboxWritablePath(
  runtimeConfig: SandboxRuntimeConfig,
  path: string,
  cwd?: string,
): boolean {
  if (!inferSandboxRuleMatch(path, runtimeConfig.filesystem.allowWrite, cwd)) return false;
  return inferSandboxRuleMatch(path, runtimeConfig.filesystem.denyWrite, cwd) === null;
}

function matchesSandboxRule(path: string, rule: string, cwd?: string): boolean {
  const normalizedPath = normalizeSandboxPath(path);
  const normalizedRule = normalizeSandboxPath(rule, cwd);

  if (containsGlobChars(rule)) {
    return new RegExp(globToRegex(normalizedRule)).test(normalizedPath);
  }

  if (normalizedPath === normalizedRule) return true;

  const prefix = normalizedRule.endsWith("/") ? normalizedRule : `${normalizedRule}/`;
  return normalizedPath.startsWith(prefix);
}
