// One real Pi window. Only the daemon executable and unsafe external work are substituted.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fsp from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import net from "node:net";
import path from "node:path";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import type {} from "./reconnect-daemon.js";

const send = (event: object) => process.send!(event);
const fs: typeof import("node:fs") = createRequire(import.meta.url)("graceful-fs");
const spawn = childProcess.spawn;
const connect = net.connect;
const agentDir = process.env.PI_CODING_AGENT_DIR!;
const configPath = path.join(agentDir, "telegram", "config.json");
const socketPath = path.join(agentDir, "run", "telegram.sock");
const daemonPath = fileURLToPath(new URL("./reconnect-daemon.js", import.meta.url));
const children: childProcess.ChildProcess[] = [];
const exited = new Map<childProcess.ChildProcess, Promise<void>>();
const failures: string[] = [];
let pendingIO = 0;
let configHeld = process.env.TELEGRAM_RECONNECT_HOLD_CONFIG === "1";
let releaseConfig!: () => void;
const configReleased = new Promise<void>((resolve) => (releaseConfig = resolve));
let probeCount = 0;
let configReads = 0;
let configWrites = 0;
let shuttingDown = false;

// Observe real IO, without replacing results. An immediate after the last completion lets its
// promise continuations schedule their next IO before a controller takes a negative assertion.
const idleWaiters = new Set<() => void>();
function completedIO() {
  pendingIO--;
  if (pendingIO === 0) for (const wake of idleWaiters) wake();
}
async function flushIO() {
  do {
    if (pendingIO > 0)
      await new Promise<void>((resolve) => {
        const wake = () => {
          idleWaiters.delete(wake);
          resolve();
        };
        idleWaiters.add(wake);
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
  } while (pendingIO > 0);
}
for (const method of ["mkdir", "stat", "utimes", "rmdir"] as const) {
  const original = fs[method] as Function;
  mock.method(fs, method, (...args: unknown[]) => {
    const callback = args.pop() as Function;
    pendingIO++;
    return original(...args, (...result: unknown[]) => {
      try {
        callback(...result);
      } finally {
        completedIO();
      }
    });
  });
}
for (const method of ["readFile", "mkdir", "writeFile", "rename", "unlink"] as const) {
  const original = fsp[method] as Function;
  mock.method(fsp, method, async (...args: unknown[]) => {
    if (
      (method === "writeFile" &&
        typeof args[0] === "string" &&
        path.dirname(args[0]) === path.dirname(configPath)) ||
      (method === "rename" && args[1] === configPath) ||
      (method === "unlink" && args[0] === configPath)
    )
      configWrites++;
    if (method === "readFile" && args[0] === configPath) {
      configReads++;
      send({ type: "config_read" });
      if (configHeld) await configReleased;
    }
    pendingIO++;
    try {
      return await original(...args);
    } finally {
      completedIO();
    }
  });
}
const reject = (boundary: string): never => {
  const message = `Unexpected ${boundary} in Telegram reconnect fixture`;
  failures.push(message);
  throw new Error(message);
};
mock.method(globalThis, "fetch", () => reject("network request"));
for (const method of [
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "spawn",
  "spawnSync",
  "fork",
] as const)
  mock.method(childProcess, method, () => reject(`subprocess ${method}`));
mock.method(net, "createConnection", () => reject("network connection"));
mock.method(net, "connect", (target: string) => {
  assert.equal(target, socketPath, "Only the owning daemon's Unix socket may be probed");
  probeCount++;
  pendingIO++;
  const socket = connect(target);
  let completed = false;
  const finish = () => {
    if (completed) return;
    completed = true;
    completedIO();
  };
  socket.once("connect", finish);
  socket.once("error", finish);
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += String(chunk);
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const response = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (response.type === "registered") send({ type: "registered" });
    }
  });
  return socket;
});
mock.method(
  childProcess,
  "spawn",
  (command: string, args: string[], options: childProcess.SpawnOptions) => {
    assert.equal(command, process.execPath);
    assert.equal(args.length, 1);
    assert.equal(path.basename(args[0]!), "daemon.mjs");
    assert.equal(options.detached, true);
    assert.deepEqual(options.stdio, ["ignore", "ignore", "ignore", "ipc"]);
    assert.equal(options.env?.TAU_TELEGRAM_STARTUP, "1");
    assert.equal(options.env?.PI_CODING_AGENT_DIR, agentDir);
    assert.equal(options.env?.TAU_TELEGRAM_PI_ENTRYPOINT, process.argv[1]);
    const child = observeChild(spawn(command, [daemonPath], options));
    send({ type: "launch", pid: child.pid });
    return child;
  },
);
function observeChild(child: childProcess.ChildProcess) {
  children.push(child);
  exited.set(child, new Promise<void>((resolve) => child.once("exit", () => resolve())));
  child.once("close", (code, signal) => {
    send({ type: "daemon_closed", pid: child.pid, code, signal });
  });
  child.on("message", (message) => send({ type: "daemon_message", pid: child.pid, message }));
  return child;
}
syncBuiltinESMExports();
mock.timers.enable({
  apis: ["Date", "setInterval", "setTimeout"],
  now: Number(process.env.TELEGRAM_RECONNECT_NOW),
});

const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
const { createPiResources, fixtureModel } = await import("../../helpers/pi.js");
const telegram = (await import("../../../extensions/telegram/index.js")).default;
const resources = await createPiResources(process.cwd(), agentDir, [telegram]);
const { session } = await createAgentSession({ ...resources, model: fixtureModel, tools: [] });
await session.bindExtensions({
  mode: "print",
  onError: (error) => failures.push(String(error)),
});
send({ type: "window_ready" });

process.on("message", (message: { id: number; action: string; ms?: number; pid?: number }) => {
  void control(message).then(
    () => {
      send({ type: "controlled", id: message.id });
      if (message.action === "dispose") process.disconnect();
    },
    (error) => send({ type: "control_error", id: message.id, error: String(error) }),
  );
});
async function control({ action, ms, pid }: { action: string; ms?: number; pid?: number }) {
  if (action === "tick") mock.timers.tick(ms!);
  else if (action === "flush") await flushIO();
  else if (action === "snapshot") {
    await flushIO();
    send({ type: "snapshot", probeCount, configReads, configWrites, failures });
  } else if (action === "release-config") {
    configHeld = false;
    releaseConfig();
  } else if (action === "external-daemon") {
    const child = observeChild(
      spawn(process.execPath, [daemonPath], {
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: { ...process.env, TAU_TELEGRAM_STARTUP: "1" },
      }),
    );
    send({ type: "external_launch", pid: child.pid });
  } else if (["ready", "fail", "ignore-term", "spawn-descendant"].includes(action)) {
    const child = children.find((entry) => entry.pid === pid);
    assert.ok(child?.connected);
    child.send({ action });
  } else if (action === "pair" || action === "unpair") {
    process.env.TAU_TELEGRAM_BOT_TOKEN = "fixture-token-not-a-real-bot";
    try {
      await session.prompt(`/telegram ${action}`);
    } finally {
      delete process.env.TAU_TELEGRAM_BOT_TOKEN;
    }
  } else if (action === "reload") await session.reload();
  else if (action === "shutdown") {
    shuttingDown = true;
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  } else if (action === "dispose") {
    if (!shuttingDown)
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      child.ref();
      process.kill(-child.pid!, "SIGKILL");
    }
    // A healthy detached daemon already disconnected its IPC. With every stdio ignored,
    // Node emits exit but not close for that handle. Canceled startups still assert close.
    await Promise.all(exited.values());
    await resources.settingsManager.flush();
    session.dispose();
    assert.deepEqual(failures, []);
  } else throw new Error(`Unexpected fixture action: ${action}`);
}
