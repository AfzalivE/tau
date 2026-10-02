import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createSandboxAuditLog,
  getSandboxAuditLogPath,
  subscribeToNewViolations,
  type SandboxAuditLog,
} from "./audit-log.js";
import { createSandboxDebugLog, type SandboxDebugLine } from "./debug.js";
import { JvmProxyAdapter } from "./jvm-proxy-adapter.js";
import type { JvmProxyEndpoint } from "./jvm-proxy-options.js";

import {
  DEFAULT_PROMPT_MODE,
  SandboxConfigLoadError,
  cloneRuntimeConfig,
  getSandboxConfigParseErrors,
  getSkippedUntrustedProjectConfigPaths,
  loadConfig,
  normalizePromptMode,
  toRuntimeConfig,
  type LoadedSandboxConfig,
  type PromptMode,
  type SandboxConfig,
  type SandboxConfigPath,
} from "./config.js";
import { createNetworkPermissions } from "./permissions/network.js";
import { isUnsandboxedApproval, showUnsandboxedApproval } from "./permissions/unsandboxed.js";

const STATUS_KEY = "sandbox";
const SANDBOX_EVENT_LIMIT = 50;

type UiLevel = "info" | "warning" | "error";

export type SandboxEventOutcome = "blocked" | "allowed";
type SandboxBypassReason = "no-sandbox-flag" | "config-disabled";
type SandboxBlockedReason = "unsupported-platform" | "init-failed" | "missing-dependencies";
type SandboxRunMode = "sandbox" | "user-disabled" | SandboxBypassReason | SandboxBlockedReason;

export type SandboxState =
  | { status: "pending" }
  | { status: "active"; runtimeConfig: SandboxRuntimeConfig }
  | { status: "suspended" }
  | { status: "bypassed"; reason: SandboxBypassReason }
  | { status: "blocked"; reason: SandboxBlockedReason };

type SandboxEventKind = "filesystem" | "network" | "mach-lookup" | "init" | "runtime";
export type SandboxEventReason =
  | "explicit-deny-read"
  | "explicit-deny-write"
  | "explicit-deny-domain"
  | "missing-allow-write"
  | "missing-allowed-domain"
  | "missing-mach-lookup"
  | "missing-dependencies"
  | "unsupported-platform"
  | "init-failed"
  | "runtime-protected-write"
  | "already-approved-still-failed"
  | "unknown";

export interface SandboxEvent {
  timestamp: number;
  kind: SandboxEventKind;
  outcome: SandboxEventOutcome;
  reason: SandboxEventReason;
  target?: string;
  command?: string;
  cwd?: string;
  summary: string;
  suggestedCommand?: string;
}

export interface SandboxRuntime {
  readonly state: SandboxState;
  readonly config: SandboxConfig | null;
  readonly promptMode: PromptMode;
  readonly context: ExtensionContext | null;
  readonly configPaths: SandboxConfigPath[];
  readonly events: SandboxEvent[];
  readonly auditLog: string;
  readonly debugLines: SandboxDebugLine[];
  describeDebugLogging(): string;
  setDebugLogging(enabled: boolean): void;
  getJvmProxyEndpoint(): JvmProxyEndpoint | null;
  getRuntimeConfig(): SandboxRuntimeConfig | null;
  captureContext(ctx: ExtensionContext): void;
  withPermissionContext<T>(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    run: (ctx: ExtensionContext, signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
  start(ctx: ExtensionContext, reason?: string): Promise<void>;
  shutdown(ctx: ExtensionContext, reason?: string): Promise<void>;
  enable(ctx: ExtensionContext): Promise<void>;
  disable(ctx: ExtensionContext): Promise<void>;
  setPromptMode(ctx: ExtensionContext, mode: PromptMode): void;
  applyRuntimeConfigForSession(ctx: ExtensionContext, runtimeConfig: SandboxRuntimeConfig): void;
  recordEvent(event: SandboxEvent): void;
}

function setSandboxStatus(
  ctx: ExtensionContext,
  enabled: boolean,
  runtimeConfig?: SandboxRuntimeConfig,
  promptMode: PromptMode = DEFAULT_PROMPT_MODE,
): void {
  if (!ctx.hasUI) return;

  if (!enabled || !runtimeConfig) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }

  const networkCount = runtimeConfig.network.allowedDomains.length;
  const writeCount = runtimeConfig.filesystem.allowWrite.length;
  const text = `sandbox (${promptMode}, ${networkCount} domains, ${writeCount} write paths)`;
  ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", text));
}

export function notify(ctx: ExtensionContext, text: string, level: UiLevel = "info"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, level);
    return;
  }

  if (level === "error" || level === "warning") console.error(text);
  else console.log(text);
}

function announceSandboxState(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  enabled: boolean,
  notification?: string,
  level: UiLevel = "info",
): void {
  const text = `Sandbox ${enabled ? "enabled" : "disabled"}`;
  notify(ctx, notification ?? text, level);
  pi.sendMessage(
    {
      customType: "sandbox-state",
      content: text,
      display: false,
    },
    { triggerTurn: false },
  );
}

function getStringFlag(pi: ExtensionAPI, name: string): string | undefined {
  const value = pi.getFlag(name);
  if (typeof value !== "string") return undefined;

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function getSandboxRunMode(state: SandboxState): SandboxRunMode {
  if (state.status === "active" || state.status === "pending") return "sandbox";
  if (state.status === "suspended") return "user-disabled";
  return state.reason;
}

function getStateRuntimeConfig(state: SandboxState): SandboxRuntimeConfig | null {
  return state.status === "active" ? state.runtimeConfig : null;
}

export function formatSandboxEventTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = `${date.getHours()}`.padStart(2, "0");
  const minutes = `${date.getMinutes()}`.padStart(2, "0");
  const seconds = `${date.getSeconds()}`.padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

export function describeSandboxRuntimeState(state: SandboxState, promptMode: PromptMode): string {
  if (state.status === "active") return `active (${promptMode})`;
  if (state.status === "pending") return "pending";
  if (state.status === "suspended") return `suspended (${promptMode})`;
  if (state.status === "bypassed") {
    if (state.reason === "no-sandbox-flag") return "bypassed (--no-sandbox)";
    return "bypassed (config disabled)";
  }
  if (state.reason === "missing-dependencies") return "blocked (missing dependencies)";
  return state.reason === "unsupported-platform"
    ? "blocked (unsupported platform)"
    : "blocked (init failed)";
}

function notifySandboxConfigParseErrors(ctx: ExtensionContext, paths: SandboxConfigPath[]): void {
  const details = paths
    .map((configPath) => `${configPath.label.toLowerCase()} (${configPath.path})`)
    .join(", ");
  notify(ctx, `Could not parse sandbox config: ${details}`, "warning");
}

function requestShutdownWithError(ctx: ExtensionContext, message: string): void {
  // Validate during session_start so we can use Pi's registered flag values and shutdown path.
  // This briefly renders startup UI, but Pi exits through its normal cleanup path instead of
  // leaving the terminal in a broken state.
  notify(ctx, message, "error");
  process.exitCode = 1;
  ctx.shutdown();
}

function loadSandboxConfigForContext(
  ctx: ExtensionContext,
  cwd: string,
  overrideConfigPath: string | undefined,
  options: { exitOnError?: boolean } = {},
): LoadedSandboxConfig | null {
  const { exitOnError = false } = options;

  try {
    return loadConfig(cwd, overrideConfigPath, { projectTrusted: ctx.isProjectTrusted() });
  } catch (error) {
    if (!(error instanceof SandboxConfigLoadError)) throw error;

    if (exitOnError) {
      requestShutdownWithError(ctx, error.message);
    } else {
      notify(ctx, error.message, "error");
    }
    return null;
  }
}

function getSandboxDependencyErrors(config: SandboxConfig): string[] {
  return SandboxManager.checkDependencies(config.ripgrep).errors;
}

function isSupportedPlatform(): boolean {
  return process.platform === "darwin" || process.platform === "linux";
}

export function createSandboxRuntime(pi: ExtensionAPI): SandboxRuntime {
  let sessionCwd = process.cwd();
  let sandboxState: SandboxState = { status: "pending" };
  let sandboxConfig: SandboxConfig | null = null;
  let promptMode: PromptMode = DEFAULT_PROMPT_MODE;
  let sessionContext: ExtensionContext | null = null;
  let sandboxConfigPaths: SandboxConfigPath[] = [];
  let sandboxEvents: SandboxEvent[] = [];
  const warnedSkippedProjectConfigPaths = new Set<string>();
  let permissionLifetime = new AbortController();
  const permissionInvocations = new Set<Promise<unknown>>();
  const debug = createSandboxDebugLog();
  let auditLog: SandboxAuditLog | null = null;
  let auditPath: string | null = null;
  let auditError: string | null = null;
  let unsubscribeAudit: (() => void) | undefined;
  let jvmProxyAdapter: JvmProxyAdapter | null = null;

  function auditPolicy(config: SandboxRuntimeConfig) {
    return {
      network: {
        allowedDomains: config.network.allowedDomains,
        deniedDomains: config.network.deniedDomains,
        allowLocalBinding: config.network.allowLocalBinding,
        allowAllUnixSockets: config.network.allowAllUnixSockets,
        allowUnixSockets: config.network.allowUnixSockets,
        allowMachLookup: config.network.allowMachLookup,
      },
      filesystem: config.filesystem,
    };
  }

  function startAudit(ctx: ExtensionContext, reason: string): void {
    auditPath = getSandboxAuditLogPath(getAgentDir(), ctx.sessionManager.getSessionId());
    auditError = null;
    const onError = (error: unknown) => {
      if (auditError) return;
      auditError = error instanceof Error ? error.message : String(error);
      notify(ctx, `Sandbox audit logging failed (${auditPath}): ${auditError}`, "warning");
    };
    try {
      const log = createSandboxAuditLog({
        agentDir: getAgentDir(),
        sessionId: ctx.sessionManager.getSessionId(),
        cwd: ctx.cwd,
        onError,
      });
      auditLog = log;
      log.append("session-start", { reason, sessionFile: ctx.sessionManager.getSessionFile() });
      unsubscribeAudit = subscribeToNewViolations(
        SandboxManager.getSandboxViolationStore(),
        (violation) =>
          log.append(
            "runtime-violation",
            {
              line: violation.line,
              command: violation.command,
              violationTimestamp: violation.timestamp.toISOString(),
            },
            violation.timestamp,
          ),
        (dropped) => log.append("runtime-violation-gap", { dropped }),
      );
    } catch (error) {
      onError(error);
    }
  }

  function stopAudit(reason: string): void {
    unsubscribeAudit?.();
    unsubscribeAudit = undefined;
    auditLog?.append("session-stop", { reason });
    auditLog?.close();
    auditLog = null;
  }

  async function closeJvmProxy(): Promise<void> {
    await jvmProxyAdapter?.close();
    jvmProxyAdapter = null;
  }

  async function configureJvmProxy(config: SandboxConfig): Promise<void> {
    jvmProxyAdapter?.suspend();
    if (!config.network.jvmProxy) return;
    const port = SandboxManager.getProxyPort();
    const authToken = SandboxManager.getProxyAuthToken();
    if (!port || !authToken)
      throw new Error("network.jvmProxy requires SRT's authenticated local HTTP proxy");
    jvmProxyAdapter ??= new JvmProxyAdapter();
    await jvmProxyAdapter.start();
    jvmProxyAdapter.activate({ port, authToken });
  }

  function recordSandboxEvent(event: SandboxEvent): void {
    sandboxEvents.push(event);
    auditLog?.append("policy-event", event, event.timestamp);
    if (sandboxEvents.length > SANDBOX_EVENT_LIMIT) {
      sandboxEvents.splice(0, sandboxEvents.length - SANDBOX_EVENT_LIMIT);
    }
  }

  function recordRuntimeEvent(
    kind: SandboxEventKind,
    reason: SandboxEventReason,
    summary: string,
  ): void {
    recordSandboxEvent({
      timestamp: Date.now(),
      kind,
      outcome: "blocked",
      reason,
      cwd: sessionCwd,
      summary,
    });
  }

  function notifySkippedUntrustedProjectConfigs(ctx: ExtensionContext): void {
    const skippedConfigs = getSkippedUntrustedProjectConfigPaths(sandboxConfigPaths).filter(
      (configPath) => !warnedSkippedProjectConfigPaths.has(configPath.path),
    );
    if (skippedConfigs.length === 0) return;

    for (const configPath of skippedConfigs) {
      warnedSkippedProjectConfigPaths.add(configPath.path);
    }

    const details = skippedConfigs.map((configPath) => configPath.path).join(", ");
    notify(
      ctx,
      `Ignoring project sandbox config because this project is not trusted: ${details}`,
      "warning",
    );
  }

  function applyRuntimeConfigForSession(
    ctx: ExtensionContext,
    runtimeConfig: SandboxRuntimeConfig,
  ): void {
    const nextConfig = cloneRuntimeConfig(runtimeConfig);
    sandboxState = { status: "active", runtimeConfig: nextConfig };
    SandboxManager.updateConfig(nextConfig);
    auditLog?.append("runtime-policy", { reason: "session-update", ...auditPolicy(nextConfig) });
    setSandboxStatus(ctx, true, nextConfig, promptMode);
  }

  const networkPermissions = createNetworkPermissions({
    getContext: () => sessionContext,
    getPromptMode: () => promptMode,
    getRuntimeConfig: () => getStateRuntimeConfig(sandboxState),
    isSuspended: () => sandboxState.status === "suspended",
    applyRuntimeConfigForSession,
    recordEvent: recordSandboxEvent,
    notify,
  });

  async function initializeSandboxRuntime(
    ctx: ExtensionContext,
    config: SandboxConfig,
  ): Promise<SandboxRuntimeConfig | null> {
    promptMode = normalizePromptMode(config.mode);

    const dependencyErrors = getSandboxDependencyErrors(config);
    if (dependencyErrors.length > 0) {
      promptMode = DEFAULT_PROMPT_MODE;
      networkPermissions.clear();
      sandboxState = { status: "blocked", reason: "missing-dependencies" };
      recordRuntimeEvent(
        "init",
        "missing-dependencies",
        `sandbox dependencies missing: ${dependencyErrors.join("; ")}`,
      );
      setSandboxStatus(ctx, false);
      notify(
        ctx,
        `Sandbox dependencies missing: ${dependencyErrors.join("; ")}. Shell execution is blocked until setup is fixed or sandboxing is explicitly disabled.`,
        "error",
      );
      return null;
    }

    const runtimeConfig = toRuntimeConfig(config);

    let initialized = false;
    try {
      if (config.network.jvmProxy) {
        if (process.platform !== "darwin")
          throw new Error("network.jvmProxy is supported only on macOS");
        if (!config.network.allowLocalBinding)
          throw new Error("network.jvmProxy requires network.allowLocalBinding: true on macOS");
      }
      await SandboxManager.initialize(runtimeConfig, networkPermissions.ask, true);
      initialized = true;
      await configureJvmProxy(config);
      const activeConfig = cloneRuntimeConfig(runtimeConfig);
      sandboxState = { status: "active", runtimeConfig: activeConfig };
      auditLog?.append("runtime-policy", { reason: "initialize", ...auditPolicy(activeConfig) });
      return activeConfig;
    } catch (error) {
      jvmProxyAdapter?.suspend();
      if (initialized) {
        try {
          await SandboxManager.reset();
        } catch {
          /* Preserve the startup error. */
        }
      }
      const errorMessage = error instanceof Error ? error.message : `${error}`;
      promptMode = DEFAULT_PROMPT_MODE;
      networkPermissions.clear();
      sandboxState = { status: "blocked", reason: "init-failed" };
      recordRuntimeEvent("init", "init-failed", `sandbox initialization failed: ${errorMessage}`);
      setSandboxStatus(ctx, false);
      notify(ctx, `Sandbox initialization failed: ${errorMessage}`, "error");
      return null;
    }
  }

  function resetRuntimeState(): void {
    sandboxState = { status: "pending" };
    sandboxConfig = null;
    promptMode = DEFAULT_PROMPT_MODE;
    sandboxConfigPaths = [];
    sandboxEvents = [];
    networkPermissions.clear();
  }

  function loadCurrentConfig(
    ctx: ExtensionContext,
    options: { exitOnError?: boolean } = {},
  ): SandboxConfig | null {
    const sandboxConfigOverride = getStringFlag(pi, "sandbox-config");
    const loadedConfig = loadSandboxConfigForContext(ctx, ctx.cwd, sandboxConfigOverride, options);
    if (!loadedConfig) return null;

    sandboxConfigPaths = loadedConfig.paths;
    notifySkippedUntrustedProjectConfigs(ctx);
    const parseErrors = getSandboxConfigParseErrors(sandboxConfigPaths);
    if (parseErrors.length > 0) {
      notifySandboxConfigParseErrors(ctx, parseErrors);
    }
    sandboxConfig = loadedConfig.config;
    debug.setEnabled(sandboxConfig.debug === true || pi.getFlag("sandbox-debug") === true);
    auditLog?.append("configuration", {
      configPaths: sandboxConfigPaths,
      policy: {
        ...sandboxConfig,
        network: {
          ...auditPolicy(sandboxConfig).network,
          jvmProxy: sandboxConfig.network.jvmProxy,
        },
      },
    });
    return loadedConfig.config;
  }

  async function start(ctx: ExtensionContext, reason = "startup"): Promise<void> {
    await cancelPermissionInvocations();
    await closeJvmProxy();
    stopAudit("session-restart");
    debug.start();
    permissionLifetime = new AbortController();
    setSandboxStatus(ctx, false);
    sessionContext = permissionContext(ctx);
    resetRuntimeState();
    sessionCwd = ctx.cwd;
    startAudit(ctx, reason);

    const noSandbox = pi.getFlag("no-sandbox") as boolean;
    if (noSandbox) {
      sandboxState = { status: "bypassed", reason: "no-sandbox-flag" };
      announceSandboxState(pi, ctx, false, "Sandbox disabled via --no-sandbox", "warning");
      return;
    }

    const config = loadCurrentConfig(ctx, { exitOnError: true });
    if (!config) return;

    if (!config.enabled) {
      sandboxState = { status: "bypassed", reason: "config-disabled" };
      announceSandboxState(pi, ctx, false, "Sandbox disabled via config");
      return;
    }

    if (!isSupportedPlatform()) {
      sandboxState = { status: "blocked", reason: "unsupported-platform" };
      recordRuntimeEvent(
        "init",
        "unsupported-platform",
        `sandbox not supported on ${process.platform}`,
      );
      notify(ctx, `Sandbox not supported on ${process.platform}`, "warning");
      return;
    }

    const runtimeConfig = await initializeSandboxRuntime(ctx, config);
    if (!runtimeConfig) return;

    setSandboxStatus(ctx, true, runtimeConfig, promptMode);
    announceSandboxState(pi, ctx, true, "Sandbox initialized");
  }

  async function shutdown(ctx: ExtensionContext, reason = "quit"): Promise<void> {
    await cancelPermissionInvocations();
    jvmProxyAdapter?.suspend();
    setSandboxStatus(ctx, false);
    if (getStateRuntimeConfig(sandboxState)) {
      try {
        await SandboxManager.reset();
      } catch {
        // Ignore cleanup errors.
      }
    }

    await closeJvmProxy();
    stopAudit(reason);
    debug.stop();
    resetRuntimeState();
    sessionContext = null;
    sessionCwd = process.cwd();
  }

  async function enable(ctx: ExtensionContext): Promise<void> {
    if (sandboxState.status === "active") {
      notify(ctx, "Sandbox is already enabled", "info");
      return;
    }

    if (!isSupportedPlatform()) {
      sandboxState = { status: "blocked", reason: "unsupported-platform" };
      recordRuntimeEvent(
        "init",
        "unsupported-platform",
        `sandbox not supported on ${process.platform}`,
      );
      notify(ctx, `Sandbox not supported on ${process.platform}`, "warning");
      return;
    }

    const config = loadCurrentConfig(ctx);
    if (!config) return;

    const runtimeConfig = await initializeSandboxRuntime(ctx, config);
    if (!runtimeConfig) return;

    setSandboxStatus(ctx, true, runtimeConfig, promptMode);
    announceSandboxState(pi, ctx, true);
  }

  async function disable(ctx: ExtensionContext): Promise<void> {
    if (sandboxState.status !== "active") {
      notify(ctx, `Sandbox is not active (mode: ${getSandboxRunMode(sandboxState)})`, "info");
      return;
    }

    sandboxState = { status: "suspended" };
    jvmProxyAdapter?.suspend();
    await cancelPermissionInvocations();
    permissionLifetime = new AbortController();
    networkPermissions.clear();
    setSandboxStatus(ctx, false);

    try {
      await SandboxManager.reset();
    } catch (error) {
      notify(
        ctx,
        `Sandbox disabled, but cleanup failed: ${error instanceof Error ? error.message : error}`,
        "warning",
      );
      return;
    }

    announceSandboxState(pi, ctx, false);
  }

  function setPromptMode(ctx: ExtensionContext, mode: PromptMode): void {
    if (promptMode !== mode) {
      permissionLifetime.abort();
      permissionLifetime = new AbortController();
    }
    promptMode = mode;
    if (sandboxState.status === "active") {
      setSandboxStatus(ctx, true, sandboxState.runtimeConfig, promptMode);
    }
  }

  /** Own invocation-local permission work until its dialog or command has settled. */
  function withPermissionContext<T>(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    run: (ctx: ExtensionContext, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const signals = [permissionLifetime.signal, ctx.signal, signal].filter(
      (value): value is AbortSignal => value !== undefined,
    );
    const combined = AbortSignal.any(signals);
    const invocationContext = permissionContext(ctx, combined);
    const invocation = (async () => {
      if (combined.aborted) throw new Error("aborted");
      return run(invocationContext, combined);
    })();
    permissionInvocations.add(invocation);
    return invocation.finally(() => permissionInvocations.delete(invocation));
  }

  async function cancelPermissionInvocations(): Promise<void> {
    permissionLifetime.abort();
    await Promise.allSettled(permissionInvocations);
  }

  function permissionContext(ctx: ExtensionContext, contextSignal = ctx.signal): ExtensionContext {
    function queued<T>(
      run: (signal?: AbortSignal) => Promise<T>,
      cancelled: T,
      signal?: AbortSignal,
    ): Promise<T> {
      const signals = [contextSignal, signal].filter(
        (value): value is AbortSignal => value !== undefined,
      );
      const combined = signals.length ? AbortSignal.any(signals) : undefined;
      const guardedRun = async (queuedSignal?: AbortSignal): Promise<T> => {
        if (queuedSignal?.aborted) return cancelled;
        const result = await run(queuedSignal);
        return queuedSignal?.aborted ? cancelled : result;
      };
      const request = {
        run: guardedRun,
        signal: combined,
        result: undefined as Promise<T> | undefined,
      };
      pi.events.emit("subagent:permission", request);
      return (request.result ?? guardedRun(combined)).catch((error: unknown) => {
        if (combined?.aborted || (error instanceof Error && error.name === "AbortError"))
          return cancelled;
        throw error;
      });
    }
    const overrides: Pick<ExtensionContext["ui"], "select" | "confirm"> = {
      select: (title, options, opts) =>
        queued(
          (signal) =>
            isUnsandboxedApproval(options) && ctx.mode === "tui"
              ? showUnsandboxedApproval(ctx, title, signal)
              : ctx.ui.select(title, options, { ...opts, signal }),
          undefined,
          opts?.signal,
        ),
      confirm: (title, message, opts) =>
        queued(
          (signal) => ctx.ui.confirm(title, message, { ...opts, signal }),
          false,
          opts?.signal,
        ),
    };
    const ui = new Proxy(ctx.ui, {
      get(_target, key) {
        const current = ctx.ui;
        return Reflect.get(overrides, key) ?? Reflect.get(current, key);
      },
    });
    return Object.defineProperties(
      {},
      {
        ...Object.getOwnPropertyDescriptors(ctx),
        ui: {
          enumerable: true,
          configurable: true,
          get() {
            void ctx.ui;
            return ui;
          },
        },
      },
    ) as ExtensionContext;
  }

  return {
    get state() {
      return sandboxState;
    },
    get config() {
      return sandboxConfig;
    },
    get promptMode() {
      return promptMode;
    },
    get context() {
      return sessionContext;
    },
    get configPaths() {
      return sandboxConfigPaths;
    },
    get events() {
      return sandboxEvents;
    },
    get auditLog() {
      return auditError ? `failed (${auditPath}): ${auditError}` : (auditPath ?? "not initialized");
    },
    get debugLines() {
      return debug.lines;
    },
    describeDebugLogging: debug.describe,
    setDebugLogging: debug.setEnabled,
    getJvmProxyEndpoint() {
      const port = jvmProxyAdapter?.activePort;
      return port ? { host: "127.0.0.1", port } : null;
    },
    getRuntimeConfig: () => getStateRuntimeConfig(sandboxState),
    captureContext(ctx) {
      sessionContext = permissionContext(ctx);
    },
    withPermissionContext,
    start,
    shutdown,
    enable,
    disable,
    setPromptMode,
    applyRuntimeConfigForSession,
    recordEvent: recordSandboxEvent,
  };
}
