import { accessSync, constants, existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type SandboxRuntimeConfig,
  SandboxRuntimeConfigSchema,
} from "@anthropic-ai/sandbox-runtime";
import { literalReadings } from "@anthropic-ai/sandbox-runtime/dist/sandbox/path-entries.js";
import {
  containsGlobChars,
  denyGlobRegex,
  globPatternBaseDir,
  globToRegex,
  isAtOrUnder,
  normalizePathForSandbox,
  properAncestors,
  removeTrailingGlobSuffix,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export type PromptMode = "interactive" | "non-interactive";
export type ListOp = "add" | "remove";
export type FilesystemList = "deny-read" | "allow-write" | "deny-write";
type FilesystemRuleList = "denyRead" | "allowRead" | "allowWrite" | "denyWrite";

type DefaultConfigExtension = {
  allowMachLookup?: string[];
  allowWrite?: string[];
  ignoreViolations?: string[];
};

// Tau normalizes configured filesystem rules to strings.
export type SandboxPolicy = Omit<SandboxRuntimeConfig, "filesystem"> & {
  filesystem: Omit<
    SandboxRuntimeConfig["filesystem"],
    "denyRead" | "allowRead" | "allowWrite" | "denyWrite"
  > & {
    denyRead: string[];
    allowRead?: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
};

export type SandboxConfig = SandboxPolicy & {
  enabled?: boolean;
  mode?: PromptMode;
  /** Omit to offer setup. False keeps manual approvals; a provider/model selects a reviewer. */
  classifier?: string | false;
  filesystem: SandboxPolicy["filesystem"] & {
    allowTempDirs?: boolean;
    allowGitCommonDir?: boolean;
  };
};

type SandboxConfigPathStatus = "loaded" | "parse-error" | "skipped-untrusted";
type SandboxConfigPathLabel = "Global" | "Project" | "Override";

export interface SandboxConfigPath {
  label: SandboxConfigPathLabel;
  path: string;
  status: SandboxConfigPathStatus;
}

export interface LoadedSandboxConfig {
  config: SandboxConfig;
  paths: SandboxConfigPath[];
}

type SandboxConfigLoadErrorKind = "not-found" | "read-failed" | "parse-error";

export const DEFAULT_PROMPT_MODE: PromptMode = "interactive";

const ENV_PATH_REFERENCE_PATTERN = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

const GLOBAL_DEFAULT_CONFIG = {
  enabled: true,
  mode: DEFAULT_PROMPT_MODE,
  network: {
    allowedDomains: [
      // System
      "localhost",
      "127.0.0.1",

      // .NET
      "nuget.org",
      "*.nuget.org",

      // Go
      "proxy.golang.org",
      "sum.golang.org",
      "go.dev",
      "golang.org",

      // Java / Kotlin
      "repo.maven.apache.org",
      "gradle.org",
      "*.gradle.org",

      // JS / TS
      "npmjs.org",
      "*.npmjs.org",
      "npmjs.com",
      "*.npmjs.com",
      "registry.yarnpkg.com",
      "nodejs.org",
      "*.nodejs.org",

      // Python
      "pypi.org",
      "*.pypi.org",
      "pythonhosted.org",
      "*.pythonhosted.org",

      // Ruby
      "rubygems.org",
      "*.rubygems.org",

      // Rust
      "crates.io",
      "*.crates.io",
      "rustup.rs",
      "*.rust-lang.org",

      // Source control
      "github.com",
      "*.github.com",
      "githubusercontent.com",
      "*.githubusercontent.com",
      "gitlab.com",
      "*.gitlab.com",
      "bitbucket.org",
      "*.bitbucket.org",

      // Containers
      "ghcr.io",
      "docker.io",
      "*.docker.io",
      "docker.com",
      "*.docker.com",

      // AI providers
      "anthropic.com",
      "*.anthropic.com",
      "claude.ai",
      "*.claude.ai",
      "openai.com",
      "*.openai.com",
      "chatgpt.com",
      "*.chatgpt.com",
      "openrouter.ai",
      "*.openrouter.ai",
      "google.com",
      "*.google.com",
      "googleapis.com",
      "*.googleapis.com",

      // Observability
      "sentry.io",
      "*.sentry.io",
      "datadoghq.com",
      "*.datadoghq.com",
      "datadoghq.eu",
      "*.datadoghq.eu",

      // Productivity
      "todoist.com",
      "*.todoist.com",
      "twist.com",
      "*.twist.com",
      "doist.com",
      "*.doist.com",
    ],
    deniedDomains: [],
    allowUnixSockets: ["$SSH_AUTH_SOCK"],
    allowLocalBinding: true,
  },
  filesystem: {
    denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
    allowRead: ["~/.ssh/config", "~/.ssh/known_hosts", "~/.ssh/*.pub"],
    allowWrite: [
      // System
      ".",
      "~/.cache",

      // Pi
      join(getAgentDir(), "*.lock"),

      // .NET
      "~/.nuget/packages",
      "~/.local/share/NuGet",

      // Go
      "~/go/pkg",

      // Java / Kotlin
      "~/.m2/repository",
      "~/.m2/wrapper/dists",
      "~/.gradle",
      "~/.konan",
      "~/.android",

      // JS / TS
      "~/.npm",

      // Python
      "~/**/__pycache__",
      "~/**/__pycache__/*",

      // Ruby
      "~/.bundle/cache",
      "~/.gem/cache",
      "~/.gem/specs",

      // Rust
      "~/.rustup",
      "~/.cargo/registry",
      "~/.cargo/git",
      "~/.cargo/.package-cache",
      "~/.cargo/.package-cache-mutate",
      "~/.cargo/.global-cache",
    ],
    denyWrite: [
      // Project secrets
      ".env",
      ".env.*",
      "*.pem",
      "*.key",

      // Java / Kotlin
      "~/.gradle/gradle.properties",
      "~/.gradle/init.gradle",
      "~/.gradle/init.gradle.kts",
      "~/.gradle/init.d",
      "~/.android/adbkey",
    ],
    allowTempDirs: true,
    allowGitConfig: true,
    allowGitCommonDir: true,
  },
  ignoreViolations: {
    "*": ["/__pycache__"],
  },
} satisfies SandboxConfig;

const MACOS_DEFAULT_CONFIG_EXTENSION: DefaultConfigExtension = {
  allowMachLookup: [
    // System
    "com.apple.dnssd.service",
    "com.apple.SystemConfiguration.configd",
    "com.apple.SystemConfiguration.DNSConfiguration",

    // Filesystem watching
    "com.apple.FSEvents",
  ],
  allowWrite: [
    // System
    "~/Library/Caches",

    // Java / Kotlin
    "~/Library/Preferences/com.apple.java.util.prefs.plist*",
    "~/Library/Application Support/kotlin",
    "~/**/kotlin-native/klib/cache/**/*",
  ],
  ignoreViolations: ["mach-lookup com.apple.usymptomsd"],
};

const LINUX_DEFAULT_CONFIG_EXTENSION: DefaultConfigExtension = {
  allowWrite: [
    // Java / Kotlin
    "~/.java/.userPrefs",
  ],
};

const PLATFORM_DEFAULT_CONFIG_EXTENSIONS: Partial<Record<NodeJS.Platform, DefaultConfigExtension>> =
  {
    darwin: MACOS_DEFAULT_CONFIG_EXTENSION,
    linux: LINUX_DEFAULT_CONFIG_EXTENSION,
  };

const {
  allowMachLookup: PLATFORM_ALLOW_MACH_LOOKUP = [],
  allowWrite: PLATFORM_ALLOW_WRITE = [],
  ignoreViolations: PLATFORM_IGNORE_VIOLATIONS = [],
} = PLATFORM_DEFAULT_CONFIG_EXTENSIONS[process.platform] ?? {};

const DEFAULT_CONFIG: SandboxConfig = {
  ...GLOBAL_DEFAULT_CONFIG,
  network: {
    ...GLOBAL_DEFAULT_CONFIG.network,
    allowMachLookup: PLATFORM_ALLOW_MACH_LOOKUP,
  },
  filesystem: {
    ...GLOBAL_DEFAULT_CONFIG.filesystem,
    allowWrite: [...GLOBAL_DEFAULT_CONFIG.filesystem.allowWrite, ...PLATFORM_ALLOW_WRITE],
  },
  ignoreViolations: {
    "*": [...GLOBAL_DEFAULT_CONFIG.ignoreViolations["*"], ...PLATFORM_IGNORE_VIOLATIONS],
  },
};

export class SandboxConfigLoadError extends Error {
  readonly kind: SandboxConfigLoadErrorKind;
  readonly path: string;

  constructor(kind: SandboxConfigLoadErrorKind, path: string, detail?: string) {
    super(formatSandboxConfigLoadErrorMessage(kind, path, detail));
    this.name = "SandboxConfigLoadError";
    this.kind = kind;
    this.path = path;
  }
}

export function normalizePromptMode(value: unknown): PromptMode {
  return value === "non-interactive" ? "non-interactive" : "interactive";
}

function expandPath(value: string, cwd?: string): string {
  const expanded =
    value === "~" ? homedir() : value.startsWith("~/") ? homedir() + value.slice(1) : value;
  return cwd && !expanded.startsWith("/") ? resolve(cwd, expanded) : expanded;
}

function formatSandboxConfigLoadErrorMessage(
  kind: SandboxConfigLoadErrorKind,
  path: string,
  detail?: string,
): string {
  if (kind === "not-found") {
    return `Sandbox override config not found: ${path}`;
  }

  if (kind === "parse-error") {
    return `Could not parse sandbox override config ${path}: ${detail ?? "invalid JSON"}`;
  }

  return `Could not read sandbox override config ${path}: ${detail ?? "unknown error"}`;
}

function cleanStringArray(value: unknown[], field: string): string[] {
  const cleaned = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  const droppedCount = value.length - cleaned.length;
  if (droppedCount > 0) {
    console.error(`Warning: Ignoring ${droppedCount} invalid values in ${field}.`);
  }

  return cleaned;
}

function coerceStringArray(value: unknown, fallback: string[], field: string): string[] {
  if (!Array.isArray(value)) {
    console.error(`Warning: Expected ${field} to be a string[]; using defaults.`);
    return [...fallback];
  }

  return cleanStringArray(value, field);
}

function coerceOptionalStringArray(
  value: unknown,
  fallback: string[] | undefined,
  field: string,
): string[] | undefined {
  if (value === undefined) return fallback ? [...fallback] : undefined;

  if (!Array.isArray(value)) {
    console.error(`Warning: Expected ${field} to be a string[]; using defaults.`);
    return fallback ? [...fallback] : undefined;
  }

  return cleanStringArray(value, field);
}

export function isClassifierId(value: unknown): value is string {
  return (
    typeof value === "string" && !containsControlCharacter(value) && /^[^\s/]+\/[^\s]+$/.test(value)
  );
}

function normalizeClassifier(value: unknown): string | false | undefined {
  if (value === undefined || value === false) return value;
  if (isClassifierId(value)) return value;
  console.error(
    "Warning: Expected classifier to be false or provider/model; using manual approvals.",
  );
  return false;
}

function finalizeConfig(config: SandboxConfig): SandboxConfig {
  return {
    ...config,
    enabled: typeof config.enabled === "boolean" ? config.enabled : DEFAULT_CONFIG.enabled,
    mode: normalizePromptMode(config.mode),
    ...(config.classifier !== undefined
      ? { classifier: normalizeClassifier(config.classifier) }
      : {}),
    network: {
      ...config.network,
      allowedDomains: coerceStringArray(
        config.network?.allowedDomains,
        DEFAULT_CONFIG.network.allowedDomains,
        "network.allowedDomains",
      ),
      deniedDomains: coerceStringArray(
        config.network?.deniedDomains,
        DEFAULT_CONFIG.network.deniedDomains,
        "network.deniedDomains",
      ),
      allowMachLookup: coerceStringArray(
        config.network?.allowMachLookup,
        DEFAULT_CONFIG.network.allowMachLookup ?? [],
        "network.allowMachLookup",
      ),
      allowUnixSockets: coerceOptionalStringArray(
        config.network?.allowUnixSockets,
        DEFAULT_CONFIG.network.allowUnixSockets,
        "network.allowUnixSockets",
      ),
    },
    filesystem: {
      ...config.filesystem,
      denyRead: coerceStringArray(
        config.filesystem?.denyRead,
        DEFAULT_CONFIG.filesystem.denyRead,
        "filesystem.denyRead",
      ),
      allowRead: coerceOptionalStringArray(
        config.filesystem?.allowRead,
        DEFAULT_CONFIG.filesystem.allowRead,
        "filesystem.allowRead",
      ),
      allowWrite: coerceStringArray(
        config.filesystem?.allowWrite,
        DEFAULT_CONFIG.filesystem.allowWrite,
        "filesystem.allowWrite",
      ),
      denyWrite: coerceStringArray(
        config.filesystem?.denyWrite,
        DEFAULT_CONFIG.filesystem.denyWrite,
        "filesystem.denyWrite",
      ),
      allowTempDirs:
        typeof config.filesystem?.allowTempDirs === "boolean"
          ? config.filesystem.allowTempDirs
          : DEFAULT_CONFIG.filesystem.allowTempDirs,
      allowGitCommonDir:
        typeof config.filesystem?.allowGitCommonDir === "boolean"
          ? config.filesystem.allowGitCommonDir
          : DEFAULT_CONFIG.filesystem.allowGitCommonDir,
    },
  };
}

function loadOverrideConfig(cwd: string, overrideConfigPath: string): LoadedSandboxConfig {
  const resolvedPath = expandPath(overrideConfigPath, cwd);

  let source: string;
  try {
    source = readFileSync(resolvedPath, "utf-8");
  } catch (error) {
    const code =
      error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;
    if (code === "ENOENT") {
      throw new SandboxConfigLoadError("not-found", resolvedPath);
    }

    throw new SandboxConfigLoadError(
      "read-failed",
      resolvedPath,
      error instanceof Error ? error.message : `${error}`,
    );
  }

  let overrideConfig: Partial<SandboxConfig>;
  try {
    overrideConfig = JSON.parse(source);
  } catch (error) {
    throw new SandboxConfigLoadError(
      "parse-error",
      resolvedPath,
      error instanceof Error ? error.message : `${error}`,
    );
  }

  return {
    config: finalizeConfig(deepMerge(DEFAULT_CONFIG, overrideConfig)),
    paths: [{ label: "Override", path: resolvedPath, status: "loaded" }],
  };
}

export function loadConfig(
  cwd: string,
  overrideConfigPath?: string,
  options: { projectTrusted?: boolean } = {},
): LoadedSandboxConfig {
  if (overrideConfigPath) {
    return loadOverrideConfig(cwd, overrideConfigPath);
  }

  const projectConfigPath = join(cwd, CONFIG_DIR_NAME, "sandbox.json");
  const globalConfigPath = join(getAgentDir(), "sandbox.json");

  let globalConfig: Partial<SandboxConfig> = {};
  let projectConfig: Partial<SandboxConfig> = {};
  const paths: SandboxConfigPath[] = [];

  if (existsSync(globalConfigPath)) {
    try {
      globalConfig = JSON.parse(readFileSync(globalConfigPath, "utf-8"));
      paths.push({ label: "Global", path: globalConfigPath, status: "loaded" });
    } catch (e) {
      paths.push({ label: "Global", path: globalConfigPath, status: "parse-error" });
      console.error(`Warning: Could not parse ${globalConfigPath}: ${e}`);
    }
  }

  if (existsSync(projectConfigPath)) {
    if (options.projectTrusted !== true) {
      paths.push({ label: "Project", path: projectConfigPath, status: "skipped-untrusted" });
    } else {
      try {
        projectConfig = JSON.parse(readFileSync(projectConfigPath, "utf-8"));
        paths.push({ label: "Project", path: projectConfigPath, status: "loaded" });
      } catch (e) {
        paths.push({ label: "Project", path: projectConfigPath, status: "parse-error" });
        console.error(`Warning: Could not parse ${projectConfigPath}: ${e}`);
      }
    }
  }

  const merged = deepMerge(deepMerge(DEFAULT_CONFIG, globalConfig), projectConfig);

  return {
    config: finalizeConfig(merged),
    paths,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: SandboxConfig, overrides: Partial<SandboxConfig>): SandboxConfig {
  const result: SandboxConfig = { ...base };

  if (overrides.enabled !== undefined) result.enabled = overrides.enabled;
  if (overrides.classifier !== undefined)
    result.classifier = normalizeClassifier(overrides.classifier);
  if (overrides.mode !== undefined) {
    result.mode = normalizePromptMode(overrides.mode);
  }
  if (isPlainObject(overrides.network)) {
    result.network = {
      ...base.network,
      ...(overrides.network as Partial<SandboxRuntimeConfig["network"]>),
    };
  }
  if (isPlainObject(overrides.filesystem)) {
    result.filesystem = {
      ...base.filesystem,
      ...(overrides.filesystem as Partial<SandboxConfig["filesystem"]>),
    };
  }
  if (overrides.ignoreViolations !== undefined) {
    result.ignoreViolations = overrides.ignoreViolations;
  }
  if (overrides.enableWeakerNestedSandbox !== undefined) {
    result.enableWeakerNestedSandbox = overrides.enableWeakerNestedSandbox;
  }
  if (overrides.enableWeakerNetworkIsolation !== undefined) {
    result.enableWeakerNetworkIsolation = overrides.enableWeakerNetworkIsolation;
  }

  return result;
}

let cachedTemporaryWritePaths: string[] | undefined;

function getTemporaryWritePaths(): string[] {
  if (cachedTemporaryWritePaths) return cachedTemporaryWritePaths;

  // allowTempDirs always includes the conventional shared temp path, even when
  // os.tmpdir() points at a platform-specific per-user directory.
  const currentTmpDir = tmpdir();
  const paths = ["/tmp", currentTmpDir, normalizePathForSandbox(currentTmpDir)];
  if (process.platform === "darwin") paths.push("/private/tmp");

  cachedTemporaryWritePaths = Array.from(
    new Set(paths.map((path) => path.replace(/\/+$/, "") || "/")),
  );
  return cachedTemporaryWritePaths;
}

function deduplicateStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function deduplicateOptionalStrings(values: string[] | undefined): string[] | undefined {
  return values ? deduplicateStrings(values) : undefined;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      return true;
    }
  }

  return false;
}

export function resolveSandboxPath(value: string, field: string, cwd: string): string | null {
  const source = value.trim();
  if (!source) return null;

  const missingEnvNames = new Set<string>();
  const expanded = source.replace(
    ENV_PATH_REFERENCE_PATTERN,
    (_match, bracedName: string | undefined, bareName: string | undefined) => {
      const envName = bracedName ?? bareName;
      const envValue = envName ? (process.env[envName]?.trim() ?? "") : "";
      if (!envValue) {
        if (envName) missingEnvNames.add(envName);
        return "";
      }
      return envValue;
    },
  );

  if (missingEnvNames.size > 0) {
    const names = Array.from(missingEnvNames).join(", ");
    const label = missingEnvNames.size === 1 ? "environment variable" : "environment variables";
    const verb = missingEnvNames.size === 1 ? "is" : "are";
    console.error(
      `Warning: Ignoring ${field} entry because ${label} ${names} ${verb} unset or empty.`,
    );
    return null;
  }

  if (containsControlCharacter(expanded)) {
    console.error(
      `Warning: Ignoring ${field} entry because the expanded path contains control characters.`,
    );
    return null;
  }

  return expandPath(expanded, cwd);
}

function expandPathConfigList(
  values: string[] | undefined,
  field: string,
  cwd: string,
): string[] | undefined {
  if (!values) return undefined;

  return values
    .map((value) => resolveSandboxPath(value, field, cwd))
    .filter((value): value is string => value !== null);
}

function expandMitmProxyPathConfig(
  mitmProxy: SandboxRuntimeConfig["network"]["mitmProxy"],
  cwd: string,
): SandboxRuntimeConfig["network"]["mitmProxy"] {
  if (!mitmProxy) return undefined;
  if (!isPlainObject(mitmProxy) || typeof mitmProxy.socketPath !== "string") return mitmProxy;

  const socketPath = resolveSandboxPath(mitmProxy.socketPath, "network.mitmProxy.socketPath", cwd);
  if (!socketPath) {
    console.error("Warning: Disabling network.mitmProxy because its socketPath did not expand.");
    return undefined;
  }

  return { ...mitmProxy, socketPath } as SandboxRuntimeConfig["network"]["mitmProxy"];
}

function expandNetworkPathConfig(
  network: SandboxRuntimeConfig["network"],
  cwd: string,
): SandboxRuntimeConfig["network"] {
  return {
    ...network,
    allowUnixSockets: expandPathConfigList(
      network.allowUnixSockets,
      "network.allowUnixSockets",
      cwd,
    ),
    mitmProxy: expandMitmProxyPathConfig(network.mitmProxy, cwd),
  };
}

function expandFilesystemPathConfig(
  filesystem: SandboxPolicy["filesystem"],
  cwd: string,
): SandboxPolicy["filesystem"] {
  return {
    ...filesystem,
    denyRead: expandPathConfigList(filesystem.denyRead, "filesystem.denyRead", cwd) ?? [],
    allowRead: expandPathConfigList(filesystem.allowRead, "filesystem.allowRead", cwd),
    allowWrite: expandPathConfigList(filesystem.allowWrite, "filesystem.allowWrite", cwd) ?? [],
    denyWrite: expandPathConfigList(filesystem.denyWrite, "filesystem.denyWrite", cwd) ?? [],
  };
}

export function toRuntimeConfig(config: SandboxConfig, cwd: string): SandboxPolicy {
  const { allowGitCommonDir: _allowGitCommonDir, allowTempDirs, ...filesystem } = config.filesystem;
  const expandedNetwork = expandNetworkPathConfig(config.network, cwd);
  const expandedFilesystem = expandFilesystemPathConfig(filesystem, cwd);
  const allowWrite = allowTempDirs
    ? [...expandedFilesystem.allowWrite, ...getTemporaryWritePaths()]
    : expandedFilesystem.allowWrite;

  const runtimeConfig: SandboxPolicy = {
    network: {
      ...expandedNetwork,
      allowUnixSockets: deduplicateOptionalStrings(expandedNetwork.allowUnixSockets),
    },
    filesystem: {
      ...expandedFilesystem,
      denyRead: deduplicateStrings(expandedFilesystem.denyRead),
      allowRead: deduplicateOptionalStrings(expandedFilesystem.allowRead),
      allowWrite: deduplicateStrings(allowWrite),
      denyWrite: deduplicateStrings(expandedFilesystem.denyWrite),
    },
    ignoreViolations: config.ignoreViolations,
    enableWeakerNestedSandbox: config.enableWeakerNestedSandbox,
    enableWeakerNetworkIsolation: config.enableWeakerNetworkIsolation,
  };

  SandboxRuntimeConfigSchema.parse(runtimeConfig);
  return runtimeConfig;
}

export function cloneRuntimeConfig(config: SandboxPolicy): SandboxPolicy {
  return structuredClone(config);
}

export function getFilesystemListValues(config: SandboxPolicy, list: FilesystemList): string[] {
  if (list === "deny-read") return config.filesystem.denyRead;
  if (list === "allow-write") return config.filesystem.allowWrite;
  return config.filesystem.denyWrite;
}

export function inferSandboxRuleMatch(
  path: string,
  rules: string[],
  list: FilesystemRuleList,
  cwd?: string,
): string | null {
  const normalizedPath = normalizeSandboxPath(path, cwd);
  for (const rule of rules) {
    if (matchesSandboxRule(normalizedPath, rule, list, cwd)) return rule;
  }

  return null;
}

function matchesSandboxRule(
  path: string,
  rule: string,
  list: FilesystemRuleList,
  cwd?: string,
): boolean {
  const spelling = expandPath(rule, cwd);
  const stripped = removeTrailingGlobSuffix(spelling);
  const kind = list === "allowRead" || list === "allowWrite" ? "allow" : "deny";
  if (!containsGlobChars(stripped)) {
    return isAtOrUnder(path, normalizeSandboxPath(stripped));
  }

  if (process.platform === "linux") {
    if (list === "allowWrite" || list === "denyWrite") {
      // Linux drops write patterns unless they also name an actual path.
      return literalReadings(stripped, kind).some(
        (reading) => !reading.glob && isAtOrUnder(path, reading.path),
      );
    }

    if (matchesLinuxReadGlob(path, normalizePathForSandbox(spelling))) return true;
    return literalReadings(spelling, kind).some((reading) =>
      reading.glob
        ? matchesLinuxReadGlob(path, reading.path, reading.anchor)
        : isAtOrUnder(path, reading.path),
    );
  }

  const compile = kind === "deny" ? denyGlobRegex : globToRegex;
  if (new RegExp(compile(normalizePathForSandbox(stripped))).test(path)) return true;

  return literalReadings(stripped, kind).some((reading) => {
    if (!reading.glob) return isAtOrUnder(path, reading.path);
    // Only the tail is pattern. The anchor may itself contain glob characters.
    return (
      path.startsWith(`${reading.anchor}/`) &&
      new RegExp(compile(reading.path.slice(reading.anchor.length))).test(
        path.slice(reading.anchor.length),
      )
    );
  });
}

function matchesLinuxReadGlob(path: string, pattern: string, anchor?: string): boolean {
  const tail = anchor === undefined ? pattern : pattern.slice(anchor.length);
  // Parent references in a glob are not names the backend's directory walk lists.
  if (/(^|\/)\.\.(\/|$)/.test(tail)) return false;
  const patternBase = globPatternBaseDir(tail);
  const base =
    anchor === undefined ? patternBase : anchor + (patternBase === "/" ? "" : patternBase);
  if (!base || base === "/" || !isAtOrUnder(path, base)) return false;

  const regex = new RegExp(globToRegex(tail), "s");
  const candidates = [path, ...properAncestors(path)].filter((candidate) =>
    isAtOrUnder(candidate, base),
  );
  // Probe only this path's depth, never enumerate a tree. An existing, unlinked
  // matching ancestor covers its subtree. Abstain on symlink or inaccessible paths.
  for (const candidate of candidates.reverse()) {
    try {
      const entry = lstatSync(candidate);
      if (entry.isSymbolicLink()) return false;
      if (regex.test(anchor === undefined ? candidate : candidate.slice(anchor.length)))
        return true;
      if (!entry.isDirectory()) return false;
      accessSync(candidate, constants.R_OK | constants.X_OK);
    } catch {
      return false;
    }
  }
  return false;
}

function normalizeSandboxPath(value: string, cwd?: string): string {
  return normalizePathForSandbox(expandPath(value, cwd), { literal: true });
}

function matchesSandboxRuleExactly(path: string, rule: string, cwd?: string): boolean {
  if (containsGlobChars(rule)) return false;
  return normalizeSandboxPath(path, cwd) === normalizeSandboxPath(rule, cwd);
}

export function inferExactSandboxRuleMatch(
  path: string,
  rules: string[],
  cwd?: string,
): string | null {
  for (const rule of rules) {
    if (matchesSandboxRuleExactly(path, rule, cwd)) return rule;
  }

  return null;
}

export function isSandboxWritablePath(
  runtimeConfig: SandboxPolicy,
  path: string,
  cwd?: string,
): boolean {
  if (!inferSandboxRuleMatch(path, runtimeConfig.filesystem.allowWrite, "allowWrite", cwd))
    return false;
  return inferSandboxRuleMatch(path, runtimeConfig.filesystem.denyWrite, "denyWrite", cwd) === null;
}

export function escapeSlashCommandArg(value: string): string {
  if (/^[a-zA-Z0-9_./:@%+\-~]+$/.test(value)) return value;
  return JSON.stringify(value);
}

export function mutateStringList(values: string[], op: ListOp, value: string): boolean {
  if (op === "add") {
    if (values.includes(value)) return false;
    values.push(value);
    return true;
  }

  const index = values.indexOf(value);
  if (index === -1) return false;
  values.splice(index, 1);
  return true;
}

export function getSandboxConfigParseErrors(paths: SandboxConfigPath[]): SandboxConfigPath[] {
  return paths.filter((configPath) => configPath.status === "parse-error");
}

export function getSkippedUntrustedProjectConfigPaths(
  paths: SandboxConfigPath[],
): SandboxConfigPath[] {
  return paths.filter((configPath) => configPath.status === "skipped-untrusted");
}
