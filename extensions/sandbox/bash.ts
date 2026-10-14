import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { BashOperations, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { findExcludedCommand, type SimpleCommand } from "./command-policy.js";
import {
  DEFAULT_COMMAND_CONFIG,
  cloneRuntimeConfig,
  inferSandboxRuleMatch,
  isSandboxWritablePath,
  mutateStringList,
  type SandboxConfig,
  type SandboxPolicy,
} from "./config.js";
import type { PermissionResolution } from "./permissions/dialog.js";
import {
  detectFilesystemViolationFromLine,
  detectFilesystemViolations,
  extractAppendedSandboxAnnotation,
  formatRuntimeProtectedWriteNotice,
  formatTraversalNotice,
  getRuntimeProtectedWriteViolations,
  getTraversalPaths,
  proposeFilesystemPermission,
  isRuntimeProtectedWriteViolation,
  isTraversalViolation,
  type FilesystemViolation,
} from "./permissions/filesystem.js";
import {
  detectMachLookupViolations,
  proposeMachLookupPermission,
} from "./permissions/mach-lookup.js";
import { notify, type SandboxEvent } from "./runtime.js";
import type { PermissionProposal, TemporaryPermissionGrant } from "./permissions/proposal.js";

const IS_MACOS = process.platform === "darwin";
const MACOS_SANDBOX_SHELL = fileURLToPath(new URL("./macos-sandbox-shell.mjs", import.meta.url));
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
const GIT_FILESYSTEM_PATHS_CACHE = new Map<string, GitFilesystemPaths | null>();

interface GitFilesystemPaths {
  gitDir: string;
  gitCommonDir: string;
}

function resolveGitFilesystemPaths(cwd: string): GitFilesystemPaths | null {
  if (GIT_FILESYSTEM_PATHS_CACHE.has(cwd)) {
    return GIT_FILESYSTEM_PATHS_CACHE.get(cwd) ?? null;
  }

  const result = spawnSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
    {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );

  if (result.status !== 0) {
    GIT_FILESYSTEM_PATHS_CACHE.set(cwd, null);
    return null;
  }

  const [gitDir, gitCommonDir] = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (!gitDir || !gitCommonDir) {
    GIT_FILESYSTEM_PATHS_CACHE.set(cwd, null);
    return null;
  }

  const gitPaths = { gitDir, gitCommonDir };
  GIT_FILESYSTEM_PATHS_CACHE.set(cwd, gitPaths);
  return gitPaths;
}

function maybeAddGitMetadataWritePath(
  runtimeConfig: SandboxPolicy,
  path: string,
  cwd?: string,
): SandboxPolicy | null {
  if (isSandboxWritablePath(runtimeConfig, path, cwd)) return null;
  if (inferSandboxRuleMatch(path, runtimeConfig.filesystem.denyWrite, "denyWrite", cwd))
    return null;

  const nextConfig = cloneRuntimeConfig(runtimeConfig);
  if (!mutateStringList(nextConfig.filesystem.allowWrite, "add", path)) return null;
  return nextConfig;
}

function appendOutputPostamble(postamble: string, addition: string, output: string): string {
  if (!addition) return postamble;

  const needsSeparator =
    postamble.length > 0 ? !postamble.endsWith("\n") : output.length > 0 && !output.endsWith("\n");

  return `${postamble}${needsSeparator ? "\n" : ""}${addition}`;
}

function ensureTrailingNewline(text: string): string {
  if (!text || text.endsWith("\n")) return text;
  return `${text}\n`;
}

interface SandboxedBashOpsOptions {
  ctx: ExtensionContext;
  getSandboxConfig: () => SandboxConfig | null;
  getRuntimeConfig: () => SandboxPolicy | null;
  applyRuntimeConfigForSession: (ctx: ExtensionContext, runtimeConfig: SandboxPolicy) => void;
  isRequired: () => boolean;
  checkCommand: (command: string, cwd: string) => string | undefined;
  recordEvent?: (event: SandboxEvent) => void;
  resolvePermission: (proposal: PermissionProposal) => Promise<PermissionResolution>;
}

interface BashAttemptResult {
  exitCode: number | null;
  combinedOutput: string;
  interruptedByFilesystemViolation: boolean;
  runtimeProtectedWriteViolations: FilesystemViolation[];
}

interface ProcessedSandboxAttempt {
  exitCode: number | null;
  postamble: string;
  resolution: PermissionResolution | null;
  runtimeProtectedWriteViolations: FilesystemViolation[];
}

interface PreparedSandboxAttempt {
  attempt: BashAttemptResult;
  commandId: string;
  runtimeConfig: SandboxPolicy | null;
  policy: SandboxPolicy | null;
}

function killProcessGroup(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals = "SIGKILL",
): void {
  if (!child.pid) return;

  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Process likely already exited.
    }
  }
}

let sandboxAttemptSequence = 0;

function createSandboxCommandId(): string {
  sandboxAttemptSequence += 1;
  return `tau-${process.pid}-${sandboxAttemptSequence}`;
}

function safeCleanupAfterCommand(): void {
  try {
    SandboxManager.cleanupAfterCommand();
  } catch {
    // Ignore cleanup errors.
  }
}

function maybeAllowGitMetadataWriteForSession(options: {
  ctx: ExtensionContext;
  cwd: string;
  runtimeConfig: SandboxPolicy | null;
  allowGitCommonDir: boolean;
  applyRuntimeConfigForSession: (ctx: ExtensionContext, runtimeConfig: SandboxPolicy) => void;
}): void {
  const { ctx, cwd, runtimeConfig, allowGitCommonDir, applyRuntimeConfigForSession } = options;
  if (!runtimeConfig) return;
  if (!isSandboxWritablePath(runtimeConfig, cwd, cwd)) return;

  const gitPaths = resolveGitFilesystemPaths(cwd);
  if (!gitPaths) return;

  let nextConfig = maybeAddGitMetadataWritePath(runtimeConfig, gitPaths.gitDir, cwd);
  if (allowGitCommonDir && gitPaths.gitCommonDir !== gitPaths.gitDir) {
    nextConfig =
      maybeAddGitMetadataWritePath(nextConfig ?? runtimeConfig, gitPaths.gitCommonDir, cwd) ??
      nextConfig;
  }

  if (!nextConfig) return;
  applyRuntimeConfigForSession(ctx, nextConfig);
}

export function createSandboxedBashOps(options: SandboxedBashOpsOptions): BashOperations {
  const {
    ctx,
    getSandboxConfig,
    getRuntimeConfig,
    applyRuntimeConfigForSession,
    isRequired,
    checkCommand,
    recordEvent,
    resolvePermission,
  } = options;
  function withSandboxDefaultEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const baseEnv = env ?? process.env;
    if (baseEnv.GIT_OPTIONAL_LOCKS !== undefined) return baseEnv;
    return { ...baseEnv, GIT_OPTIONAL_LOCKS: "0" };
  }

  async function runSandboxAttempt(
    commandId: string,
    wrappedCommand: string,
    cwd: string,
    runtimeConfig: SandboxPolicy | null,
    onData: (data: Buffer) => void,
    signal?: AbortSignal,
    timeout?: number,
    env?: NodeJS.ProcessEnv,
  ): Promise<BashAttemptResult> {
    return new Promise((resolve, reject) => {
      const child = spawn("bash", ["-c", wrappedCommand], {
        cwd,
        env: withSandboxDefaultEnv(env),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const chunks: Buffer[] = [];
      let timedOut = false;
      let interruptedByFilesystemViolation = false;
      let seenViolationCount = 0;
      const runtimeProtectedWriteViolations = new Map<string, FilesystemViolation>();
      let timeoutHandle: NodeJS.Timeout | undefined;
      let timeoutEscalationHandle: NodeJS.Timeout | undefined;
      let filesystemStopEscalationHandle: NodeJS.Timeout | undefined;

      const stopForFilesystemViolation = (): void => {
        if (interruptedByFilesystemViolation) return;

        interruptedByFilesystemViolation = true;
        killProcessGroup(child, "SIGTERM");
        filesystemStopEscalationHandle = setTimeout(() => {
          killProcessGroup(child, "SIGKILL");
        }, 500);
      };

      // The Linux monitor now includes mandatory denies within cwd, but its telemetry is
      // attacker-controlled and session-scoped. Keep live interruption macOS-only.
      const unsubscribeViolations =
        process.platform !== "darwin"
          ? () => undefined
          : SandboxManager.getSandboxViolationStore().subscribe(() => {
              const violations =
                SandboxManager.getSandboxViolationStore().getViolationsForCommand(commandId);
              if (violations.length <= seenViolationCount) return;

              const newViolations = violations.slice(seenViolationCount);
              seenViolationCount = violations.length;

              for (const violation of newViolations) {
                const filesystemViolation = detectFilesystemViolationFromLine(violation.line);
                if (filesystemViolation) {
                  if (isTraversalViolation(runtimeConfig, filesystemViolation, cwd)) continue;

                  if (isRuntimeProtectedWriteViolation(runtimeConfig, filesystemViolation, cwd)) {
                    if (filesystemViolation.path) {
                      runtimeProtectedWriteViolations.set(
                        filesystemViolation.path,
                        filesystemViolation,
                      );
                    }
                    continue;
                  }

                  stopForFilesystemViolation();
                }
              }
            });

      if (timeout !== undefined && timeout > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          killProcessGroup(child, "SIGTERM");
          timeoutEscalationHandle = setTimeout(() => {
            killProcessGroup(child, "SIGKILL");
          }, 2000);
        }, timeout * 1000);
      }

      child.stdout?.on("data", (data) => {
        chunks.push(data);
        onData(data);
      });
      child.stderr?.on("data", (data) => {
        chunks.push(data);
        onData(data);
      });

      const onAbort = () => {
        killProcessGroup(child, "SIGKILL");
      };

      child.on("error", (err) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (timeoutEscalationHandle) clearTimeout(timeoutEscalationHandle);
        if (filesystemStopEscalationHandle) clearTimeout(filesystemStopEscalationHandle);
        unsubscribeViolations();
        signal?.removeEventListener("abort", onAbort);
        killProcessGroup(child, "SIGKILL");
        reject(err);
      });

      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }

      child.on("close", (code) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (timeoutEscalationHandle) clearTimeout(timeoutEscalationHandle);
        if (filesystemStopEscalationHandle) clearTimeout(filesystemStopEscalationHandle);
        unsubscribeViolations();
        signal?.removeEventListener("abort", onAbort);

        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }

        if (timedOut) {
          reject(new Error(`timeout:${timeout}`));
          return;
        }

        resolve({
          exitCode: interruptedByFilesystemViolation && code === null ? 1 : code,
          combinedOutput: Buffer.concat(chunks).toString("utf-8"),
          interruptedByFilesystemViolation,
          runtimeProtectedWriteViolations: Array.from(runtimeProtectedWriteViolations.values()),
        });
      });
    });
  }

  async function runExcludedCommand(
    command: SimpleCommand,
    cwd: string,
    onData: (data: Buffer) => void,
    signal?: AbortSignal,
    timeout?: number,
    env?: NodeJS.ProcessEnv,
  ): Promise<{ exitCode: number | null }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command.rawExecutable, command.args, {
        cwd,
        env: { ...(env ?? process.env), ...command.env },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      let escalation: NodeJS.Timeout | undefined;
      const onAbort = () => killProcessGroup(child);
      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(escalation);
        signal?.removeEventListener("abort", onAbort);
      };
      if (timeout !== undefined) {
        timer = setTimeout(() => {
          timedOut = true;
          killProcessGroup(child, "SIGTERM");
          escalation = setTimeout(() => killProcessGroup(child), 2000);
        }, timeout * 1000);
      }
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.on("error", (error) => {
        cleanup();
        killProcessGroup(child);
        reject(error);
      });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      child.on("close", (exitCode) => {
        cleanup();
        if (signal?.aborted) reject(new Error("aborted"));
        else if (timedOut) reject(new Error(`timeout:${timeout}`));
        else resolve({ exitCode });
      });
    });
  }

  function validateTimeout(timeout: number | undefined): void {
    if (timeout === undefined) return;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new Error("Invalid timeout: must be a finite number of seconds");
    }
    if (timeout * 1000 > MAX_TIMEOUT_MS) {
      throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
    }
  }

  function getRemainingTimeout(timeout: number | undefined, startedAt: number): number | undefined {
    if (timeout === undefined) return undefined;

    return Math.max(0, timeout - (Date.now() - startedAt) / 1000);
  }

  function reportPostProcessingError(error: unknown): void {
    const message = `[sandbox] Post-processing error: ${error instanceof Error ? error.message : error}`;
    notify(ctx, message, "warning");
  }

  async function prepareAndRunSandboxAttempt(options: {
    command: string;
    cwd: string;
    onData: (data: Buffer) => void;
    signal?: AbortSignal;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
    grant?: TemporaryPermissionGrant;
  }): Promise<PreparedSandboxAttempt> {
    const { command, cwd, onData, signal, timeout, env, grant } = options;

    if (!grant) {
      maybeAllowGitMetadataWriteForSession({
        ctx,
        cwd,
        runtimeConfig: getRuntimeConfig(),
        allowGitCommonDir: getSandboxConfig()?.filesystem.allowGitCommonDir === true,
        applyRuntimeConfigForSession,
      });
    }
    const policy = getRuntimeConfig();
    if (grant && policy !== grant.policy) {
      throw new Error(
        "Sandbox policy changed after classification; the temporary retry was cancelled.",
      );
    }
    const runtimeConfig = grant?.config ?? policy;
    const attemptRuntimeConfig = runtimeConfig ? cloneRuntimeConfig(runtimeConfig) : null;
    const commandId = createSandboxCommandId();

    const wrappedCommand = await SandboxManager.wrapWithSandbox(
      command,
      IS_MACOS ? MACOS_SANDBOX_SHELL : undefined,
      attemptRuntimeConfig ?? undefined,
      signal,
      { commandId, commandText: command },
    );

    try {
      if (signal?.aborted) throw new Error("aborted");
      if (grant && getRuntimeConfig() !== grant.policy) {
        throw new Error("Sandbox policy changed while preparing the classifier-approved retry.");
      }
      const attempt = await runSandboxAttempt(
        commandId,
        wrappedCommand,
        cwd,
        attemptRuntimeConfig,
        onData,
        signal,
        timeout,
        env,
      );
      return { attempt, commandId, runtimeConfig: attemptRuntimeConfig, policy };
    } catch (err) {
      safeCleanupAfterCommand();
      throw err;
    }
  }

  async function processSandboxAttempt(options: {
    attempt: BashAttemptResult;
    command: string;
    commandId: string;
    cwd: string;
    runtimeConfig: SandboxPolicy | null;
    policy: SandboxPolicy | null;
    autoRetryAvailable: boolean;
  }): Promise<ProcessedSandboxAttempt> {
    const { attempt, command, commandId, cwd, runtimeConfig, policy, autoRetryAvailable } = options;
    const annotatedOutput = SandboxManager.annotateStderrWithSandboxFailures(
      commandId,
      attempt.combinedOutput,
    );
    // Capture violations delivered after the child closed but before post-processing.
    const storedViolationLines = SandboxManager.getSandboxViolationStore()
      .getViolationsForCommand(commandId)
      .map((violation) => violation.line);
    const storedFilesystemViolations = storedViolationLines
      .map(detectFilesystemViolationFromLine)
      .filter((violation): violation is FilesystemViolation => violation !== null);
    const runtimeProtectedWriteViolations = getRuntimeProtectedWriteViolations(
      runtimeConfig,
      [...attempt.runtimeProtectedWriteViolations, ...storedFilesystemViolations],
      cwd,
    );
    const machLookupViolations = detectMachLookupViolations(storedViolationLines);
    const processed: ProcessedSandboxAttempt = {
      exitCode: attempt.exitCode,
      postamble: extractAppendedSandboxAnnotation(attempt.combinedOutput, annotatedOutput),
      resolution: null,
      runtimeProtectedWriteViolations,
    };

    if (runtimeProtectedWriteViolations.length > 0) {
      const notice = formatRuntimeProtectedWriteNotice(
        runtimeProtectedWriteViolations,
        !attempt.interruptedByFilesystemViolation,
      );
      processed.postamble = appendOutputPostamble(
        processed.postamble,
        notice,
        attempt.combinedOutput,
      );

      for (const violation of runtimeProtectedWriteViolations) {
        recordEvent?.({
          timestamp: Date.now(),
          kind: "filesystem",
          outcome: "blocked",
          reason: "runtime-protected-write",
          target: violation.path,
          command,
          cwd,
          summary: "filesystem write is protected by the sandbox runtime",
        });
      }
    }

    const commandSucceeded = attempt.exitCode === 0 && !attempt.interruptedByFilesystemViolation;
    if (commandSucceeded) return processed;

    if (
      /\bsandbox-exec:\s+sandbox_apply:\s+Operation not permitted\b/i.test(attempt.combinedOutput)
    ) {
      const notice =
        "[sandbox] macOS sandbox initialization failed in a child process. An inherited sandbox can cause this.";
      recordEvent?.({
        timestamp: Date.now(),
        kind: "runtime",
        outcome: "blocked",
        reason: "init-failed",
        command,
        cwd,
        summary: "command reported a sandbox initialization failure",
      });
      processed.postamble = appendOutputPostamble(
        processed.postamble,
        notice,
        attempt.combinedOutput,
      );
      return processed;
    }

    const traversalPaths =
      storedViolationLines.length === storedFilesystemViolations.length
        ? getTraversalPaths({ runtimeConfig, violations: storedFilesystemViolations, cwd })
        : null;
    const continuedTraversal = machLookupViolations.length === 0 ? traversalPaths : null;
    if (continuedTraversal) {
      processed.exitCode = 0;
      processed.postamble = appendOutputPostamble(
        processed.postamble,
        formatTraversalNotice(continuedTraversal),
        attempt.combinedOutput,
      );
      return processed;
    }

    const currentRuntimeConfig = getRuntimeConfig();
    if (!currentRuntimeConfig) return processed;

    const proposalOptions = {
      runtimeConfig: currentRuntimeConfig,
      command,
      cwd,
      rawOutput: attempt.combinedOutput,
      autoRetryAvailable,
      automaticReviewAvailable: policy === currentRuntimeConfig,
    };
    const proposal =
      proposeFilesystemPermission({
        ...proposalOptions,
        violations: storedFilesystemViolations.length
          ? storedFilesystemViolations
          : detectFilesystemViolations(attempt.combinedOutput, machLookupViolations.length === 0),
        diagnosticSource: storedFilesystemViolations.length
          ? IS_MACOS
            ? "seatbelt-denial"
            : "linux-write-attempt"
          : "process-output",
        runtimeProtectedWriteViolations,
      }) ?? proposeMachLookupPermission({ ...proposalOptions, violations: machLookupViolations });
    if (proposal) processed.resolution = await resolvePermission(proposal);
    if (processed.resolution?.message) {
      processed.postamble = appendOutputPostamble(
        processed.postamble,
        processed.resolution.message,
        attempt.combinedOutput,
      );
    }
    return processed;
  }

  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      validateTimeout(timeout);
      if (!existsSync(cwd)) {
        throw new Error(`Working directory does not exist: ${cwd}`);
      }

      const blocked = checkCommand(command, cwd);
      if (blocked) throw new Error(blocked);
      const commands = getSandboxConfig()?.commands ?? DEFAULT_COMMAND_CONFIG;
      const excluded = findExcludedCommand(command, commands.excluded, commands.exclusionsEnabled);
      if (excluded) {
        const required = isRequired();
        const summary = required
          ? `Sandbox is required, but this command matches commands.excluded entry \`${excluded.pattern}\`. Disable exclusions to test it inside the sandbox.`
          : `command bypassed sandbox via commands.excluded entry \`${excluded.pattern}\``;
        recordEvent?.({
          timestamp: Date.now(),
          kind: "command",
          outcome: required ? "blocked" : "allowed",
          reason: "excluded-command",
          target: excluded.executable,
          command,
          cwd,
          summary,
        });
        if (required) throw new Error(summary);
        const message = `[sandbox] Running excluded command outside sandbox: ${excluded.rawExecutable} (matched ${excluded.pattern})`;
        onData(Buffer.from(`${message}\n`));
        notify(ctx, message);
        return runExcludedCommand(excluded.command, cwd, onData, signal, timeout, env);
      }

      const attemptStartedAt = Date.now();
      let attemptTimeout = timeout;
      let retry: Extract<PermissionResolution, { kind: "allow-retry" }> | undefined;
      for (;;) {
        const run = await prepareAndRunSandboxAttempt({
          command,
          cwd,
          onData,
          signal,
          timeout: attemptTimeout,
          env,
          grant: retry?.grant,
        });
        let processed: ProcessedSandboxAttempt;
        try {
          processed = await processSandboxAttempt({
            ...run,
            command,
            cwd,
            autoRetryAvailable: !retry,
          });
        } catch (postProcessError) {
          reportPostProcessingError(postProcessError);
          safeCleanupAfterCommand();
          return { exitCode: run.attempt.exitCode };
        }

        if (retry) {
          let message = "";
          if (processed.exitCode === 0) {
            message = retry.grant
              ? "\n[sandbox] Classifier-approved retry completed. The temporary exception was not saved.\n"
              : `\n${retry.blockedTarget}\n\nAccess granted ${grantScope(retry)} and the command was retried successfully.`;
          } else if (
            !processed.resolution &&
            processed.runtimeProtectedWriteViolations.length === 0
          ) {
            message = retry.grant
              ? "\n[sandbox] Classifier-approved retry failed. No further automatic retry is allowed.\n"
              : `\n${retry.blockedTarget}\n\nAccess granted ${grantScope(retry)} and the command was retried per user request, but the command still exited non-zero. The sandbox block was resolved; the remaining failure may be unrelated.`;
          }
          processed.postamble = appendOutputPostamble(
            processed.postamble,
            message,
            run.attempt.combinedOutput,
          );
        }

        // A resolution from the retry can never schedule a third launch.
        const nextRetry =
          !retry && processed.resolution?.kind === "allow-retry" ? processed.resolution : undefined;
        if (processed.postamble) {
          onData(
            Buffer.from(
              nextRetry ? ensureTrailingNewline(processed.postamble) : processed.postamble,
            ),
          );
        }
        if (nextRetry) run.attempt.combinedOutput = "";
        safeCleanupAfterCommand();
        if (!nextRetry) return { exitCode: processed.exitCode };

        attemptTimeout = getRemainingTimeout(timeout, attemptStartedAt);
        if (attemptTimeout !== undefined && attemptTimeout <= 0) {
          const message = nextRetry.grant
            ? "\n[sandbox] Classifier-approved retry skipped because the timeout was exhausted.\n"
            : `\n${nextRetry.blockedTarget}\n\nAccess granted ${grantScope(nextRetry)}, but automatic retry was skipped because the timeout was exhausted. Retry the command manually if needed.`;
          onData(Buffer.from(message));
          return { exitCode: processed.exitCode };
        }
        retry = nextRetry;
      }
    },
  };
}

function grantScope(resolution: Extract<PermissionResolution, { kind: "allow-retry" }>): string {
  return resolution.saved ? "globally for future sessions" : "for this session";
}
