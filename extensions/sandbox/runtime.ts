import {
  SandboxManager,
  SandboxRuntimeConfigSchema,
  type SandboxAskCallback,
} from "@anthropic-ai/sandbox-runtime";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  DEFAULT_PROMPT_MODE,
  SandboxConfigLoadError,
  cloneRuntimeConfig,
  escapeSlashCommandArg,
  getSandboxConfigParseErrors,
  getSkippedUntrustedProjectConfigPaths,
  loadConfig,
  isClassifierId,
  normalizePromptMode,
  toRuntimeConfig,
  type LoadedSandboxConfig,
  type PromptMode,
  type SandboxConfig,
  type SandboxConfigPath,
  type SandboxPolicy,
} from "./config.js";
import {
  createSandboxReviewer,
  delegatedReviewHistory,
  SANDBOX_REVIEW_OUTCOMES,
  type SandboxDelegation,
  type SandboxReviewDiagnostic,
  type SandboxReviewOutcome,
  type SandboxReviewRequest,
  type SandboxReviewResult,
} from "./classifier.js";
import { delegatedHistory, delegatedRequest, delegatedResult } from "./classifier/delegation.js";
import { createPermissionResolver, type PermissionResolution } from "./permissions/dialog.js";
import type { PermissionProposal } from "./permissions/proposal.js";

const STATUS_KEY = "sandbox";
const SANDBOX_EVENT_LIMIT = 50;
const REVIEW_ENTRY_TYPE = "sandbox-review";

export const APPLE_EVENTS_WARNING =
  "allowAppleEvents removes code-execution isolation: launched applications run outside sandbox filesystem and network restrictions.";

type UiLevel = "info" | "warning" | "error";

export type SandboxEventOutcome = "blocked" | "allowed";
type SandboxBypassReason = "no-sandbox-flag" | "config-disabled";
type SandboxBlockedReason = "unsupported-platform" | "init-failed" | "missing-dependencies";
type SandboxRunMode = "sandbox" | "user-disabled" | SandboxBypassReason | SandboxBlockedReason;

export type SandboxState =
  | { status: "pending" }
  | { status: "active"; runtimeConfig: SandboxPolicy }
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

export interface SandboxPermissionEvent {
  type?: never;
  timestamp: number;
  kind: SandboxEventKind;
  outcome: SandboxEventOutcome;
  reason: SandboxEventReason;
  target?: string;
  command?: string;
  cwd?: string;
  summary: string;
  suggestedCommand?: string;
  toolCallId?: string;
}

export interface SandboxReviewEvent extends SandboxReviewDiagnostic {
  type: "review";
  timestamp: number;
  kind: "filesystem" | "network" | "mach-lookup";
  toolCallId?: string;
  persistenceFailed?: true;
}

export type SandboxEvent = SandboxPermissionEvent | SandboxReviewEvent;

export interface SandboxInvocation<C extends ExtensionContext = ExtensionContext> {
  ctx: C;
  signal: AbortSignal;
  prompts: Pick<ExtensionContext["ui"], "select" | "confirm">;
  usages: Usage[];
  pending: Set<Promise<boolean>>;
  toolCallId?: string;
  activeCommand?: { text: string; cwd: string };
}

interface SubagentReview {
  ctx: ExtensionContext;
  childId: string;
  request: unknown;
  history: unknown;
  toolCallId?: string;
  signal: AbortSignal;
  result?: Promise<SandboxReviewResult>;
}

export interface SandboxRuntime {
  readonly state: SandboxState;
  readonly config: SandboxConfig | null;
  readonly promptMode: PromptMode;
  readonly configPaths: SandboxConfigPath[];
  readonly events: SandboxEvent[];
  getRuntimeConfig(): SandboxPolicy | null;
  runBash<C extends ExtensionContext, T>(
    ctx: C,
    signal: AbortSignal,
    run: (invocation: SandboxInvocation<C>) => Promise<T>,
    toolCallId?: string,
  ): Promise<T>;
  resolvePermission(
    proposal: PermissionProposal,
    invocation: SandboxInvocation,
  ): Promise<PermissionResolution>;
  classifierSelection(ctx: ExtensionContext): string | false | undefined;
  configureClassifier(ctx: ExtensionContext): Promise<void>;
  withPermissionLifetime<T>(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
  start(ctx: ExtensionContext): Promise<void>;
  shutdown(ctx: ExtensionContext): Promise<void>;
  enable(ctx: ExtensionContext): Promise<void>;
  disable(ctx: ExtensionContext): Promise<void>;
  setPromptMode(ctx: ExtensionContext, mode: PromptMode): void;
  applyRuntimeConfigForSession(ctx: ExtensionContext, runtimeConfig: SandboxPolicy): void;
  recordEvent(event: SandboxEvent): void;
}

function setSandboxStatus(
  ctx: ExtensionContext,
  enabled: boolean,
  runtimeConfig?: SandboxPolicy,
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
  runtimeConfig: SandboxPolicy | null,
  notification?: string,
  level: UiLevel = "info",
): void {
  const warning = process.platform === "darwin" && runtimeConfig?.allowAppleEvents;
  const text = `Sandbox ${runtimeConfig ? "enabled" : "disabled"}${warning ? `. Warning: ${APPLE_EVENTS_WARNING}` : ""}`;
  notify(ctx, warning ? text : (notification ?? text), warning ? "warning" : level);
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

function getStateRuntimeConfig(state: SandboxState): SandboxPolicy | null {
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
  let sandboxConfigPaths: SandboxConfigPath[] = [];
  let sandboxEvents: SandboxEvent[] = [];
  const warnedSkippedProjectConfigPaths = new Set<string>();
  let permissionLifetime = new AbortController();
  const permissionInvocations = new Set<Promise<unknown>>();
  let invocation: SandboxInvocation | undefined;
  let executionQueue: Promise<void> = Promise.resolve();
  let reviewerBusy = false;
  let activeReview: AbortController | undefined;
  let permissionGeneration = 0;
  const owners = new WeakMap<
    SandboxInvocation,
    { generation: number; sessionId: string; leafId: string | null }
  >();
  const reviewer = createSandboxReviewer(pi, {
    getSelection: () => sandboxConfig?.classifier,
  });
  pi.on("input", () => {
    // New directions may still be queued rather than visible in the selected branch.
    activeReview?.abort();
  });
  pi.events.on("sandbox:subagent-review", (data) => {
    if (process.env.TAU_SUBAGENT_CHILD === "1") return;
    const request = data as SubagentReview;
    request.result = reviewSubagent(request);
  });
  pi.on("session_tree", async (_event, ctx) => {
    permissionGeneration++;
    await cancelPermissionInvocations();
    permissionLifetime = new AbortController();
    reviewer.reset();
    restoreReviewEvents(ctx);
  });

  function classifierEligible(ctx: ExtensionContext): boolean {
    return ctx.hasUI && ["tui", "rpc"].includes(ctx.mode) && process.env.TAU_SUBAGENT_CHILD !== "1";
  }

  async function review(
    owner: SandboxInvocation,
    request: SandboxReviewRequest,
    delegation?: SandboxDelegation,
  ): Promise<SandboxReviewResult> {
    const skip = (outcome: SandboxReviewOutcome): SandboxReviewResult => ({
      diagnostic: { outcome, attempted: false },
    });
    if (owner.signal.aborted) return skip("cancelled");
    if (sandboxState.status !== "active") return skip("inactive");
    if (!owner.ctx.hasUI || !["tui", "rpc"].includes(owner.ctx.mode)) return skip("ineligible");
    if (owner.ctx.hasPendingMessages()) return skip("stale-context");
    if (reviewerBusy) return skip("busy");
    reviewerBusy = true;
    const contextChanged = new AbortController();
    activeReview = contextChanged;
    const signal = AbortSignal.any([owner.signal, contextChanged.signal]);
    try {
      let result: SandboxReviewResult;
      if (process.env.TAU_SUBAGENT_CHILD === "1") {
        const normalized = delegatedRequest(request);
        if (!normalized) return skip("invalid-input");
        const handoff = {
          request: normalized,
          history: delegatedReviewHistory(owner.ctx),
          toolCallId: safeToolCallId(owner.toolCallId) ? owner.toolCallId : undefined,
          signal,
          result: undefined as Promise<unknown> | undefined,
        };
        let received: unknown;
        try {
          pi.events.emit("subagent:sandbox-review", handoff);
          if (!handoff.result) return skip("ineligible");
          received = await handoff.result;
        } catch {
          return skip(owner.signal.aborted ? "cancelled" : "unavailable");
        }
        if (received === undefined) return skip(owner.signal.aborted ? "cancelled" : "ineligible");
        result = delegatedResult(received);
      } else {
        result = await reviewer.review(
          owner.ctx,
          request,
          signal,
          owner.prompts.select,
          delegation,
        );
      }
      if (result.usage) owner.usages.push(result.usage);
      if (
        !owner.signal.aborted &&
        (contextChanged.signal.aborted || owner.ctx.hasPendingMessages())
      ) {
        delete result.approvedBy;
        result.diagnostic = { ...result.diagnostic, outcome: "stale-context" };
      }
      return result;
    } finally {
      activeReview = undefined;
      reviewerBusy = false;
    }
  }

  async function reviewSubagent(handoff: SubagentReview): Promise<SandboxReviewResult> {
    const request = delegatedRequest(handoff.request);
    const history = delegatedHistory(handoff.history);
    if (
      !request ||
      !history ||
      typeof handoff.childId !== "string" ||
      !/^[\w-]{1,64}$/.test(handoff.childId)
    ) {
      return { diagnostic: { outcome: "invalid-input", attempted: false } };
    }
    return withPermissionLifetime(handoff.ctx, handoff.signal, async (signal) => {
      const tool = safeToolCallId(handoff.toolCallId) ? `/${handoff.toolCallId}` : "";
      const owner = permissionOwner(handoff.ctx, signal, `subagent/${handoff.childId}${tool}`);
      const select = owner.prompts.select;
      owner.prompts.select = (title, choices, options) =>
        select(`${handoff.childId}\n${title}`, choices, options);
      const policy = getStateRuntimeConfig(sandboxState);
      const intent = authorizationContextKey(owner.ctx);
      const result: SandboxReviewResult =
        promptMode === "non-interactive"
          ? { diagnostic: { outcome: "non-interactive" as const, attempted: false } }
          : await review(owner, request, { childId: handoff.childId, history });
      if (result.approvedBy) {
        const stale =
          signal.aborted || !ownerIsCurrent(owner)
            ? "cancelled"
            : getStateRuntimeConfig(sandboxState) !== policy
              ? "stale-policy"
              : authorizationContextKey(owner.ctx) !== intent
                ? "stale-context"
                : undefined;
        if (stale) {
          delete result.approvedBy;
          result.diagnostic = { ...result.diagnostic, outcome: stale };
        }
      }
      recordReview(request.kind, owner, result.diagnostic);
      return result;
    }).catch(() => ({ diagnostic: { outcome: "cancelled", attempted: false } }));
  }

  function authorizationContextKey(ctx: ExtensionContext): string {
    return ctx.sessionManager
      .getBranch()
      .filter(
        (entry) =>
          entry.type === "context_edit" ||
          (entry.type === "message" && entry.message.role === "user"),
      )
      .map((entry) => entry.id)
      .join(",");
  }

  async function configureClassifier(ctx: ExtensionContext): Promise<void> {
    if (!classifierEligible(ctx)) return;
    if (reviewerBusy) {
      try {
        notify(
          ctx,
          "Sandbox classifier review is busy. Try setup again when it finishes.",
          "warning",
        );
      } catch {
        // A failed notice must not interfere with the running review.
      }
      return;
    }
    await withPermissionLifetime(ctx, undefined, async (signal) => {
      reviewerBusy = true;
      try {
        await reviewer.configure(ctx, signal, permissionPrompts(ctx, signal).select);
      } finally {
        reviewerBusy = false;
      }
    });
  }

  function recordSandboxEvent(event: SandboxEvent): void {
    sandboxEvents.push(event);
    if (sandboxEvents.length > SANDBOX_EVENT_LIMIT) {
      sandboxEvents.splice(0, sandboxEvents.length - SANDBOX_EVENT_LIMIT);
    }
  }

  function ownerIsCurrent(owner: SandboxInvocation): boolean {
    const identity = owners.get(owner);
    if (!identity || identity.generation !== permissionGeneration) return false;
    try {
      const manager = owner.ctx.sessionManager;
      return (
        manager.getSessionId() === identity.sessionId &&
        (identity.leafId === null ||
          manager.getBranch().some((entry) => entry.id === identity.leafId))
      );
    } catch {
      // Pi invalidates contexts during session replacement and reload.
      return false;
    }
  }

  function recordPermissionEvent(event: SandboxPermissionEvent, owner: SandboxInvocation): void {
    if (ownerIsCurrent(owner) && !owner.signal.aborted) {
      recordSandboxEvent({
        ...event,
        toolCallId: safeToolCallId(owner.toolCallId) ? owner.toolCallId : undefined,
      });
    }
  }

  function recordReview(
    kind: PermissionProposal["kind"],
    owner: SandboxInvocation,
    diagnostic: SandboxReviewDiagnostic,
  ): void {
    if (!ownerIsCurrent(owner)) return;
    const classifier = diagnostic.classifier ?? reviewer.selection(owner.ctx);
    const event = validatedReviewEvent({
      type: "review",
      timestamp: Date.now(),
      kind,
      outcome: diagnostic.outcome,
      attempted: diagnostic.attempted,
      ...(isClassifierId(classifier) && classifier.length <= 512 ? { classifier } : {}),
      ...(diagnostic.label === undefined ? {} : { label: diagnostic.label }),
      ...(safeToolCallId(owner.toolCallId) ? { toolCallId: owner.toolCallId } : {}),
    });
    if (!event) return;
    try {
      pi.appendEntry(REVIEW_ENTRY_TYPE, event);
    } catch {
      const failed: SandboxReviewEvent = { ...event, persistenceFailed: true };
      recordSandboxEvent(failed);
      return;
    }
    recordSandboxEvent(event);
  }

  function restoreReviewEvents(ctx: ExtensionContext): void {
    sandboxEvents = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== REVIEW_ENTRY_TYPE) continue;
      const event = validatedReviewEvent(entry.data);
      if (event) recordSandboxEvent(event);
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

  function applyRuntimeConfigForSession(ctx: ExtensionContext, runtimeConfig: SandboxPolicy): void {
    const nextConfig = cloneRuntimeConfig(runtimeConfig);
    SandboxRuntimeConfigSchema.parse(nextConfig);
    SandboxManager.updateConfig(nextConfig);
    sandboxState = { status: "active", runtimeConfig: nextConfig };
    setSandboxStatus(ctx, true, nextConfig, promptMode);
  }

  const resolvePermission = createPermissionResolver({
    getPromptMode: () => promptMode,
    getRuntimeConfig: () => getStateRuntimeConfig(sandboxState),
    applyRuntimeConfigForSession,
    recordEvent: recordPermissionEvent,
    recordReview,
    notify,
    review,
  });
  const askNetworkPermission: SandboxAskCallback = async ({ host, port }) => {
    const owner = invocation;
    if (!owner || owner.signal.aborted) return false;
    if (sandboxState.status === "suspended") return true;
    const policy = getStateRuntimeConfig(sandboxState);
    if (!policy) return false;
    const normalizedHost = host.toLowerCase();
    if (policy.network.allowedDomains.includes(normalizedHost)) return true;
    const target = port ? `${normalizedHost}:${port}` : normalizedHost;
    if (policy.network.deniedDomains.includes(normalizedHost)) {
      recordSandboxEvent({
        timestamp: Date.now(),
        kind: "network",
        outcome: "blocked",
        reason: "explicit-deny-domain",
        target,
        cwd: owner.ctx.cwd,
        summary: "network access matched a deny list entry",
        suggestedCommand: `/sandbox network deny remove ${escapeSlashCommandArg(normalizedHost)}`,
      });
      return false;
    }

    const decision = resolvePermission(
      {
        kind: "network",
        policy,
        target,
        cwd: owner.ctx.cwd,
        operation: "connect",
        reason: "missing-allowed-domain",
        alreadyApplied: false,
        action: { list: "network-allow", op: "add", value: normalizedHost },
        autoRetryAvailable: false,
        automatic: {
          permission: {
            host: normalizedHost,
            ...(port === undefined ? {} : { port }),
            scope: "this pending proxy connection only",
            commandAttribution:
              "unknown: the native proxy provides no originating command identity or request payload; activeCommand is unverified context only",
            ...(owner.activeCommand ? { activeCommand: owner.activeCommand } : {}),
          },
        },
      },
      owner,
    ).then((result) => result.kind === "allow-connection");
    owner.pending.add(decision);
    try {
      return await decision;
    } finally {
      owner.pending.delete(decision);
    }
  };

  async function initializeSandboxRuntime(
    ctx: ExtensionContext,
    config: SandboxConfig,
  ): Promise<SandboxPolicy | null> {
    promptMode = normalizePromptMode(config.mode);

    const dependencyErrors = getSandboxDependencyErrors(config);
    if (dependencyErrors.length > 0) {
      promptMode = DEFAULT_PROMPT_MODE;
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

    try {
      const runtimeConfig = toRuntimeConfig(config, ctx.cwd);
      await SandboxManager.initialize(runtimeConfig, askNetworkPermission, true);
      const activeConfig = cloneRuntimeConfig(runtimeConfig);
      sandboxState = { status: "active", runtimeConfig: activeConfig };
      return activeConfig;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : `${error}`;
      promptMode = DEFAULT_PROMPT_MODE;
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
    return loadedConfig.config;
  }

  async function start(ctx: ExtensionContext): Promise<void> {
    permissionGeneration++;
    await cancelPermissionInvocations();
    permissionLifetime = new AbortController();
    setSandboxStatus(ctx, false);
    resetRuntimeState();
    restoreReviewEvents(ctx);
    reviewer.reset();
    sessionCwd = ctx.cwd;

    const noSandbox = pi.getFlag("no-sandbox") as boolean;
    if (noSandbox) {
      sandboxState = { status: "bypassed", reason: "no-sandbox-flag" };
      announceSandboxState(pi, ctx, null, "Sandbox disabled via --no-sandbox", "warning");
      return;
    }

    const config = loadCurrentConfig(ctx, { exitOnError: true });
    if (!config) return;

    if (!config.enabled) {
      sandboxState = { status: "bypassed", reason: "config-disabled" };
      announceSandboxState(pi, ctx, null, "Sandbox disabled via config");
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
    announceSandboxState(pi, ctx, runtimeConfig, "Sandbox initialized");
  }

  async function shutdown(ctx: ExtensionContext): Promise<void> {
    permissionGeneration++;
    await cancelPermissionInvocations();
    setSandboxStatus(ctx, false);
    if (getStateRuntimeConfig(sandboxState)) {
      try {
        await SandboxManager.reset();
      } catch {
        // Ignore cleanup errors.
      }
    }

    resetRuntimeState();
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
    announceSandboxState(pi, ctx, runtimeConfig);
  }

  async function disable(ctx: ExtensionContext): Promise<void> {
    if (sandboxState.status !== "active") {
      notify(ctx, `Sandbox is not active (mode: ${getSandboxRunMode(sandboxState)})`, "info");
      return;
    }

    sandboxState = { status: "suspended" };
    await cancelPermissionInvocations();
    permissionLifetime = new AbortController();
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

    announceSandboxState(pi, ctx, null);
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

  /** Serialize Bash and own all of its permission work until cancellation and joining finish. */
  function runBash<C extends ExtensionContext, T>(
    ctx: C,
    signal: AbortSignal,
    run: (owner: SandboxInvocation<C>) => Promise<T>,
    toolCallId?: string,
  ): Promise<T> {
    const completion = new AbortController();
    const combined = AbortSignal.any([signal, completion.signal]);
    return runSerially(async () => {
      const owner = permissionOwner(ctx, combined, toolCallId);
      invocation = owner;
      try {
        const result = await run(owner);
        if (combined.aborted) throw new Error("aborted");
        return result;
      } finally {
        completion.abort();
        while (owner.pending.size) await Promise.allSettled(owner.pending);
        invocation = undefined;
      }
    }, combined);
  }

  function permissionOwner<C extends ExtensionContext>(
    ctx: C,
    signal: AbortSignal,
    toolCallId?: string,
  ): SandboxInvocation<C> {
    const owner: SandboxInvocation<C> = {
      ctx,
      signal,
      prompts: permissionPrompts(ctx, signal),
      usages: [],
      pending: new Set(),
      toolCallId,
    };
    owners.set(owner, {
      generation: permissionGeneration,
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId(),
    });
    return owner;
  }

  function runSerially<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let pending = true;
      const cancel = () => {
        if (!pending) return;
        pending = false;
        signal.removeEventListener("abort", cancel);
        reject(new Error("aborted"));
      };
      if (signal.aborted) {
        cancel();
        return;
      }
      signal.addEventListener("abort", cancel, { once: true });
      const start = async () => {
        if (!pending) return;
        pending = false;
        signal.removeEventListener("abort", cancel);
        try {
          resolve(await task());
        } catch (error) {
          reject(error);
        }
      };
      executionQueue = executionQueue.then(start, start);
    });
  }

  /** Own invocation-local permission work until its dialog or command has settled. */
  function withPermissionLifetime<T>(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const signals = [permissionLifetime.signal, ctx.signal, signal].filter(
      (value): value is AbortSignal => value !== undefined,
    );
    const combined = AbortSignal.any(signals);
    const invocation = (async () => {
      if (combined.aborted) throw new Error("aborted");
      return run(combined);
    })();
    permissionInvocations.add(invocation);
    return invocation.finally(() => permissionInvocations.delete(invocation));
  }

  async function cancelPermissionInvocations(): Promise<void> {
    permissionLifetime.abort();
    await Promise.allSettled(permissionInvocations);
  }

  function permissionPrompts(
    ctx: ExtensionContext,
    contextSignal: AbortSignal,
  ): SandboxInvocation["prompts"] {
    function queued<T>(
      run: (signal?: AbortSignal) => Promise<T>,
      cancelled: T,
      signal?: AbortSignal,
    ): Promise<T> {
      const combined = signal ? AbortSignal.any([contextSignal, signal]) : contextSignal;
      if (combined.aborted) return Promise.resolve(cancelled);
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
        if (combined.aborted || (error instanceof Error && error.name === "AbortError"))
          return cancelled;
        throw error;
      });
    }
    return {
      select: (title, options, opts) =>
        queued(
          (signal) => ctx.ui.select(title, options, { ...opts, signal }),
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
    get configPaths() {
      return sandboxConfigPaths;
    },
    get events() {
      return sandboxEvents;
    },
    getRuntimeConfig: () => getStateRuntimeConfig(sandboxState),
    runBash,
    resolvePermission,
    classifierSelection: reviewer.selection,
    configureClassifier,
    withPermissionLifetime,
    start,
    shutdown,
    enable,
    disable,
    setPromptMode,
    applyRuntimeConfigForSession,
    recordEvent: recordSandboxEvent,
  };
}

/** Only a fixed diagnostic schema is restored. No provider text or permission payload is retained. */
function validatedReviewEvent(value: unknown): SandboxReviewEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const event = value as Record<string, unknown>;
  const kind = (["filesystem", "network", "mach-lookup"] as const).find(
    (kind) => kind === event.kind,
  );
  const outcome = SANDBOX_REVIEW_OUTCOMES.find((outcome) => outcome === event.outcome);
  const label = (["low", "high", "approve", "escalate"] as const).find(
    (label) => label === event.label,
  );
  const classifier =
    isClassifierId(event.classifier) && event.classifier.length <= 512
      ? event.classifier
      : undefined;
  const toolCallId = safeToolCallId(event.toolCallId) ? event.toolCallId : undefined;
  const fields = [
    "type",
    "timestamp",
    "kind",
    "outcome",
    "attempted",
    "classifier",
    "label",
    "toolCallId",
  ];
  if (
    Object.keys(event).some((key) => !fields.includes(key)) ||
    event.type !== "review" ||
    typeof event.timestamp !== "number" ||
    !Number.isSafeInteger(event.timestamp) ||
    event.timestamp < 0 ||
    event.timestamp > 8_640_000_000_000_000 ||
    kind === undefined ||
    outcome === undefined ||
    typeof event.attempted !== "boolean" ||
    (event.classifier !== undefined && classifier === undefined) ||
    (event.label !== undefined && (!event.attempted || label === undefined))
  )
    return undefined;
  return {
    type: "review",
    timestamp: event.timestamp,
    kind,
    outcome,
    attempted: event.attempted,
    ...(classifier === undefined ? {} : { classifier }),
    ...(label === undefined ? {} : { label }),
    ...(toolCallId === undefined ? {} : { toolCallId }),
  };
}

function safeToolCallId(value: unknown): value is string {
  return typeof value === "string" && /^[\w.:/|+-]{1,256}$/.test(value);
}
