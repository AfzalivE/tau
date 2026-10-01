import { chmodSync, closeSync, constants, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";

const AUDIT_LOG_VERSION = 1;

export interface SandboxAuditLog {
  readonly path: string;
  append(type: string, data: unknown, timestamp?: Date | number | string): void;
  close(): void;
}

export interface ViolationTailStore<T> {
  getTotalCount(): number;
  subscribe(listener: (violations: T[]) => void): () => void;
}

export function getSandboxAuditLogPath(agentDir: string, sessionId: string): string {
  const safeSessionId = sanitizeFileName(sessionId) || "unknown-session";
  return join(agentDir, "logs", "sandbox", `${safeSessionId}.jsonl`);
}

export function createSandboxAuditLog(options: {
  agentDir: string;
  sessionId: string;
  cwd: string;
  onError?: (error: Error) => void;
}): SandboxAuditLog {
  const { agentDir, sessionId, cwd, onError } = options;
  const path = getSandboxAuditLogPath(agentDir, sessionId);
  const directory = join(agentDir, "logs", "sandbox");

  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(directory, 0o700);

  let descriptor: number | null = openSync(
    path,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY,
    0o600,
  );
  if (process.platform !== "win32") chmodSync(path, 0o600);

  let errorReported = false;

  const reportError = (error: unknown): void => {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original audit-log error.
      }
      descriptor = null;
    }

    if (errorReported) return;
    errorReported = true;
    try {
      onError?.(error instanceof Error ? error : new Error(`${error}`));
    } catch {
      // Audit logging must never affect sandbox enforcement.
    }
  };

  return {
    path,
    append(type, data, timestamp = Date.now()) {
      if (descriptor === null) return;

      try {
        const record = {
          version: AUDIT_LOG_VERSION,
          timestamp: normalizeTimestamp(timestamp),
          sessionId,
          cwd,
          type,
          data,
        };
        writeSync(descriptor, `${JSON.stringify(record)}\n`);
      } catch (error) {
        reportError(error);
      }
    },
    close() {
      if (descriptor === null) return;

      try {
        closeSync(descriptor);
        descriptor = null;
      } catch (error) {
        reportError(error);
      }
    },
  };
}

export function subscribeToNewViolations<T>(
  store: ViolationTailStore<T>,
  onViolation: (violation: T) => void,
  onDropped?: (count: number) => void,
): () => void {
  let observedCount = store.getTotalCount();

  return store.subscribe((violations) => {
    const totalCount = store.getTotalCount();
    if (totalCount <= observedCount) {
      if (totalCount < observedCount) observedCount = totalCount;
      return;
    }

    const unseenCount = totalCount - observedCount;
    const availableCount = Math.min(unseenCount, violations.length);
    const droppedCount = unseenCount - availableCount;
    const newViolations =
      availableCount === 0 ? [] : violations.slice(violations.length - availableCount);
    observedCount = totalCount;

    if (droppedCount > 0) onDropped?.(droppedCount);
    for (const violation of newViolations) onViolation(violation);
  });
}

function normalizeTimestamp(timestamp: Date | number | string): string {
  if (timestamp instanceof Date) return timestamp.toISOString();
  if (typeof timestamp === "number") return new Date(timestamp).toISOString();
  return timestamp;
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
}
