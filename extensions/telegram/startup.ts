import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { lock } from "proper-lockfile";

const RETRY_DELAYS_MS = [5_000, 20_000, 60_000];
const STARTUP_TIMEOUT_MS = 10_000;
const LOCK_WAIT_MS = 15_000;

type RetryState = { failures: number; retryAt: number };

export async function ensureDaemonRunning(options: {
  agentDir: string;
  daemonPath: string;
  entrypoint: string;
  signal?: AbortSignal;
  automatic?: boolean;
  shouldStart?: () => Promise<boolean>;
}): Promise<boolean> {
  const { agentDir, daemonPath, entrypoint, automatic = false, shouldStart } = options;
  const socketPath = path.join(agentDir, "run", "telegram.sock");
  if (await canConnectSocket(socketPath, options.signal)) return true;

  const started = await withDaemonStartupLock(
    agentDir,
    async (signal) => {
      if (await canConnectSocket(socketPath, signal)) return true;
      if (shouldStart && !(await shouldStart())) return false;
      signal.throwIfAborted();
      const statePath = path.join(agentDir, "run", "telegram-startup.json");
      const previous = await readRetryState(statePath);
      if (automatic && previous && Date.now() < previous.retryAt) return false;
      const failures = Math.min((previous?.failures ?? 0) + 1, RETRY_DELAYS_MS.length);
      const next = () => ({ failures, retryAt: Date.now() + RETRY_DELAYS_MS[failures - 1]! });
      // Retain a cooldown even if the launching Pi process exits unexpectedly.
      await writeRetryState(statePath, next(), signal);
      try {
        await launchDaemon(daemonPath, agentDir, entrypoint, socketPath, signal);
        signal.throwIfAborted();
        await unlink(statePath);
        return true;
      } catch (error) {
        // launchDaemon joins failed/cancelled children before another owner can retry.
        if (!signal.aborted) await writeRetryState(statePath, next(), signal);
        throw error;
      }
    },
    { signal: options.signal, wait: !automatic },
  );
  return started ?? false;
}

/** A registered connection can also come from a daemon started outside this launcher. */
export async function resetDaemonStartupRetry(
  agentDir: string,
  isConnected: () => boolean,
  signal: AbortSignal,
): Promise<void> {
  await withDaemonStartupLock(
    agentDir,
    async (lockedSignal) => {
      lockedSignal.throwIfAborted();
      if (!isConnected()) return;
      await unlink(path.join(agentDir, "run", "telegram-startup.json")).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        },
      );
    },
    { signal, wait: false },
  );
}

/** Serialize launch and unpair operations across every window using this agent directory. */
export async function withDaemonStartupLock<T>(
  agentDir: string,
  run: (signal: AbortSignal) => Promise<T>,
  options: { signal?: AbortSignal; wait?: boolean } = {},
): Promise<T | undefined> {
  const directory = path.join(agentDir, "run");
  const lease = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, lease.signal]) : lease.signal;
  signal.throwIfAborted();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const deadline =
    options.wait === false
      ? undefined
      : setTimeout(
          () => lease.abort(new Error("Timed out waiting for Telegram startup")),
          LOCK_WAIT_MS,
        );
  let release: (() => Promise<void>) | undefined;
  try {
    while (!release) {
      signal.throwIfAborted();
      try {
        release = await lock(path.join(directory, "telegram-startup.json"), {
          realpath: false,
          retries: 0,
          stale: 30_000,
          onCompromised: (error) => lease.abort(error),
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
        if (options.wait === false) return undefined;
        await delay(100, undefined, { signal });
      }
    }
    clearTimeout(deadline);
    signal.throwIfAborted();
    return await run(signal);
  } finally {
    clearTimeout(deadline);
    await release?.();
  }
}

export async function canConnectSocket(socketPath: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const finish = (connected: boolean, error?: unknown) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", aborted);
      socket.destroy();
      if (error) reject(error);
      else resolve(connected);
    };
    const aborted = () => finish(false, signal?.reason);
    const timeout = setTimeout(
      () => finish(false, new Error("Telegram socket probe timed out")),
      1_000,
    );
    socket.once("connect", () => finish(true));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(false, ["ENOENT", "ECONNREFUSED"].includes(error.code ?? "") ? undefined : error);
    });
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

async function launchDaemon(
  daemonPath: string,
  agentDir: string,
  entrypoint: string,
  socketPath: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      TAU_TELEGRAM_PI_ENTRYPOINT: entrypoint,
      TAU_TELEGRAM_STARTUP: "1",
    },
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let cleanup = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onMessage = (message: unknown) => {
        if (
          message &&
          typeof message === "object" &&
          "type" in message &&
          message.type === "telegram_ready"
        ) {
          finish();
        }
      };
      const onClose = () => finish(new Error("Telegram daemon exited before becoming ready"));
      const onError = (error: Error) => finish(error);
      const onAbort = () => finish(signal.reason);
      const timer = setTimeout(
        () => finish(new Error("Telegram daemon startup timed out")),
        STARTUP_TIMEOUT_MS,
      );
      cleanup = () => {
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("close", onClose);
        child.off("error", onError);
        signal.removeEventListener("abort", onAbort);
      };
      child.on("message", onMessage);
      child.once("close", onClose);
      child.once("error", onError);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    if (!(await canConnectSocket(socketPath, signal))) {
      throw new Error("Telegram daemon reported readiness without a listening socket");
    }
    signal.throwIfAborted();
    if (child.connected) child.disconnect();
    child.unref();
  } catch (error) {
    await terminateStartup(child, closed);
    throw error;
  } finally {
    cleanup();
  }
}

async function terminateStartup(child: ChildProcess, closed: Promise<void>): Promise<void> {
  let killError: unknown;
  const kill = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") killError = error;
    }
  };
  kill("SIGTERM");
  const timeout = setTimeout(() => kill("SIGKILL"), 1_000);
  try {
    await closed;
  } finally {
    clearTimeout(timeout);
    // The leader's close does not imply that credential subprocesses have exited.
    kill("SIGKILL");
  }
  if (killError) throw killError;
}

async function readRetryState(file: string): Promise<RetryState | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const state = JSON.parse(raw) as Partial<RetryState> | null;
  if (
    !state ||
    !Number.isInteger(state.failures) ||
    state.failures! < 1 ||
    state.failures! > RETRY_DELAYS_MS.length ||
    typeof state.retryAt !== "number" ||
    !Number.isSafeInteger(state.retryAt) ||
    state.retryAt < 0
  )
    throw new Error("Invalid Telegram startup retry state");
  return state as RetryState;
}

async function writeRetryState(
  file: string,
  state: RetryState,
  signal: AbortSignal,
): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    signal.throwIfAborted();
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { flag: "wx", mode: 0o600 });
    signal.throwIfAborted();
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
