import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { containsGlobChars } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import { lock } from "proper-lockfile";
import {
  expandPathConfigEntry,
  hasPathConfigReference,
  loadConfig,
  toRuntimeConfig,
  type SandboxConfig,
} from "../config.js";
import { findFileToolPolicyViolation, resolveFileToolAccesses } from "../file-tool-guard.js";
import { normalizeSandboxPath } from "../utils.js";

export type SandboxPermissionChange = (
  | { section: "network"; list: "allowedDomains" | "allowMachLookup" }
  | { section: "filesystem"; list: "denyRead" | "denyWrite" | "allowWrite" }
) & {
  op: "add" | "remove";
  value: string;
  target: string;
  access?: "read" | "write";
};

type SaveOptions = {
  projectTrusted: boolean;
  overrideConfigPath?: string;
  signal?: AbortSignal;
};
type JsonObject = Record<string, unknown>;

/** A published change remains saved even if lock or temporary-file cleanup fails. */
export class SandboxPermissionSaveError extends Error {
  readonly path: string;
  readonly saved: boolean;

  constructor(path: string, saved: boolean, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `${saved ? "Saved global sandbox permission, but cleanup failed for" : "Could not save global sandbox permission to"} ${path}: ${detail}`,
      { cause },
    );
    this.name = "SandboxPermissionSaveError";
    this.path = path;
    this.saved = saved;
  }
}

export async function saveGlobalPermission(
  cwd: string,
  change: SandboxPermissionChange,
  options: SaveOptions,
): Promise<{ path: string; changed: boolean }> {
  options.signal?.throwIfAborted();
  await validateChange(cwd, change);
  options.signal?.throwIfAborted();
  const configPath = await resolveConfigPath();
  let compromised: Error | undefined;
  const release = await lock(configPath, {
    realpath: false,
    retries: { retries: 10, factor: 1, minTimeout: 100, maxTimeout: 100 },
    onCompromised: (error) => {
      compromised = error;
    },
  });
  let temporary: string | undefined;
  let published = false;
  let changed = false;
  let failure: unknown;
  try {
    options.signal?.throwIfAborted();
    const source = await readFile(configPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return "{}";
    });
    const current: unknown = JSON.parse(source);
    if (!isObject(current)) throw new Error("Sandbox configuration must be a JSON object");
    const next = applyGlobalChange(cwd, current, change);
    changed = next !== current;
    assertPermissionEffective(cwd, next, change, { projectTrusted: false });
    assertPermissionEffective(cwd, next, change, options);
    if (compromised) throw compromised;
    options.signal?.throwIfAborted();
    if (changed) {
      const candidate = `${configPath}.${randomUUID()}.tmp`;
      const file = await open(candidate, "wx", 0o600);
      temporary = candidate;
      try {
        await file.writeFile(`${JSON.stringify(next, null, 2)}\n`, "utf8");
      } finally {
        await file.close();
      }
      // Recheck path resolution and project/override policy after I/O. Global writers share this lease.
      await validateChange(cwd, change);
      assertPermissionEffective(cwd, next, change, options);
      options.signal?.throwIfAborted();
      if (compromised) throw compromised;
      // Cooperative locking cannot fence arbitrary external editors or OS pauses.
      await rename(temporary, configPath);
      temporary = undefined;
      published = true;
    }
  } catch (error) {
    failure = error;
  } finally {
    for (const cleanup of [
      async () => {
        if (temporary) await unlink(temporary);
      },
      release,
    ]) {
      try {
        await cleanup();
      } catch (error) {
        failure = failure ? new AggregateError([failure, error], "Save and cleanup failed") : error;
      }
    }
    failure ??= compromised;
  }
  if (failure) throw new SandboxPermissionSaveError(configPath, published, failure);
  return { path: configPath, changed };
}

async function validateChange(cwd: string, change: SandboxPermissionChange): Promise<void> {
  const validList =
    change.section === "network"
      ? ["allowedDomains", "allowMachLookup"].includes(change.list) && change.op === "add"
      : change.section === "filesystem" &&
        ((change.list === "allowWrite" && change.op === "add") ||
          (["denyRead", "denyWrite"].includes(change.list) && change.op === "remove"));
  if (!validList) throw new Error("Unsupported persistent sandbox permission change");
  for (const value of [change.value, change.target]) {
    if (typeof value !== "string" || !value.trim() || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) {
      throw new Error("Sandbox permission targets and rules must be nonempty, single-line strings");
    }
  }
  if (change.section === "network") {
    if (change.value !== change.target || /[\s*]/u.test(change.target)) {
      throw new Error("Persistent network permissions must name the exact host or service");
    }
  } else {
    if (!isAbsolute(change.target) || !["read", "write"].includes(change.access ?? "")) {
      throw new Error("Filesystem permissions require an absolute target and read/write access");
    }
    if (
      change.list === "allowWrite" &&
      (change.value !== change.target || change.access !== "write")
    ) {
      throw new Error("Persistent write access must name the exact absolute target");
    }
    if (change.list === "allowWrite") {
      const canonical = await resolveFileToolAccesses("write", { path: change.value }, cwd);
      const paths = [
        change.value,
        normalizeSandboxPath(change.value, cwd),
        ...canonical!.map((access) => access.path),
      ];
      if (paths.some((path) => containsGlobChars(path) || hasPathConfigReference(path))) {
        throw new Error(
          "Persistent write access requires a literal path without glob characters or environment references",
        );
      }
    }
  }
}

function applyGlobalChange(
  cwd: string,
  current: JsonObject,
  change: SandboxPermissionChange,
): JsonObject {
  const section = current[change.section];
  if (section !== undefined && !isObject(section)) {
    throw new Error(`${change.section} must be an object`);
  }
  const rawList = section?.[change.list];
  if (rawList !== undefined) assertStringList(rawList, `${change.section}.${change.list}`);
  // Do not let load-time coercion hide malformed lists used to verify this permission.
  const policyLists =
    change.section === "filesystem"
      ? change.access === "read"
        ? ["denyRead", "allowRead"]
        : ["denyWrite", "allowWrite"]
      : change.list === "allowedDomains"
        ? ["allowedDomains", "deniedDomains"]
        : ["allowMachLookup"];
  for (const list of policyLists) {
    if (section?.[list] !== undefined) assertStringList(section[list], `${change.section}.${list}`);
  }
  const baseline = loadConfig(cwd, undefined, {
    projectTrusted: false,
    globalConfig: current as Partial<SandboxConfig>,
  }).config;
  const defaults =
    change.section === "network" ? baseline.network[change.list] : baseline.filesystem[change.list];
  const values = (rawList ?? defaults ?? []) as string[];
  const matches = (value: string): boolean => {
    const expanded =
      change.section === "filesystem"
        ? expandPathConfigEntry(value, `${change.section}.${change.list}`)
        : value.trim();
    return change.list === "allowedDomains"
      ? expanded?.toLowerCase() === change.value.toLowerCase()
      : expanded === change.value;
  };
  const index = values.findIndex(matches);
  if ((change.op === "add" && index !== -1) || (change.op === "remove" && index === -1)) {
    return current;
  }
  const nextValues =
    change.op === "add" ? [...values, change.value] : values.filter((value) => !matches(value));
  return { ...current, [change.section]: { ...section, [change.list]: nextValues } };
}

function assertPermissionEffective(
  cwd: string,
  candidate: JsonObject,
  change: SandboxPermissionChange,
  options: SaveOptions,
): void {
  const loaded = loadConfig(cwd, options.overrideConfigPath, {
    projectTrusted: options.projectTrusted,
    globalConfig: candidate as Partial<SandboxConfig>,
  });
  if (loaded.paths.some((entry) => entry.status === "parse-error")) {
    throw new Error("Cannot verify permission with malformed sandbox configuration");
  }
  if (!loaded.config.enabled) throw new Error("Sandbox configuration disables the sandbox");
  const runtime = toRuntimeConfig(loaded.config);
  const allowed =
    change.section === "filesystem"
      ? !findFileToolPolicyViolation([{ kind: change.access!, path: change.target }], runtime, cwd)
      : change.list === "allowMachLookup"
        ? runtime.network.allowMachLookup?.includes(change.target)
        : !matchesDomainList(change.target, runtime.network.deniedDomains) &&
          matchesDomainList(change.target, runtime.network.allowedDomains);
  if (!allowed) {
    throw new Error(
      `Global permission does not allow ${change.target} under the current sandbox policy; project or --sandbox-config policy and remaining denies take precedence`,
    );
  }
}

function matchesDomainList(host: string, rules: string[]): boolean {
  const normalizedHost = host.toLowerCase();
  return rules.some((rule) => {
    const normalizedRule = rule.toLowerCase();
    if (normalizedRule === "*") return true;
    if (!normalizedRule.startsWith("*.")) return normalizedHost === normalizedRule;
    const suffix = normalizedRule.slice(1);
    return normalizedHost.length > suffix.length && normalizedHost.endsWith(suffix);
  });
}

function assertStringList(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`${field} must be a string[] with nonempty entries`);
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Resolve aliases before locking and publishing so a save preserves configuration symlinks.
async function resolveConfigPath(): Promise<string> {
  const configPath = join(getAgentDir(), "sandbox.json");
  await mkdir(dirname(configPath), { recursive: true });
  try {
    return await realpath(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const entry = await lstat(configPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (entry) throw new Error("Cannot save through an unresolved configuration symlink");
    return join(await realpath(dirname(configPath)), "sandbox.json");
  }
}
