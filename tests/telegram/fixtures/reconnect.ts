// Separate coordinator process. Only clocks are controlled; locks, sockets and daemon children are real.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import path from "node:path";
import { mock } from "node:test";
import timers from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type {} from "./reconnect-daemon.js";

const send = (event: object) => process.send!(event);
const agentDir = process.env.PI_CODING_AGENT_DIR!;
const daemonPath = fileURLToPath(new URL("./reconnect-daemon.js", import.meta.url));
const children: childProcess.ChildProcess[] = [];
const exits: Promise<void>[] = [];
const operations: { controller: AbortController; done: Promise<unknown> }[] = [];
const spawn = childProcess.spawn;
const connect = net.connect;
const failures: Error[] = [];
const reject = () => {
  const error = new Error("Unexpected subprocess or network request in Telegram startup fixture");
  failures.push(error);
  throw error;
};
mock.method(globalThis, "fetch", reject);
mock.method(net, "createConnection", reject);
for (const method of ["exec", "execSync", "execFile", "execFileSync", "spawnSync", "fork"] as const)
  mock.method(childProcess, method, reject);
mock.method(net, "connect", (target: string) => {
  assert.equal(target, path.join(agentDir, "run", "telegram.sock"));
  return connect(target);
});
mock.method(
  childProcess,
  "spawn",
  (command: string, args: string[], options: childProcess.SpawnOptions) => {
    assert.equal(command, process.execPath);
    assert.deepEqual(args, [daemonPath]);
    assert.equal(options.detached, true);
    const child = spawn(command, args, options);
    children.push(child);
    exits.push(new Promise<void>((resolve) => child.once("exit", () => resolve())));
    child.on("message", (message) => send({ type: "daemon_message", pid: child.pid, message }));
    child.once("close", (code, signal) =>
      send({ type: "daemon_closed", pid: child.pid, code, signal }),
    );
    send({ type: "launch", pid: child.pid });
    return child;
  },
);
mock.timers.enable({
  apis: ["Date", "setTimeout"],
  now: Number(process.env.TELEGRAM_RECONNECT_NOW),
});
// A manual contender's public delay call is the completion signal for encountering the real lock.
const delay = timers.setTimeout;
mock.method(timers, "setTimeout", (...args: Parameters<typeof delay>) => {
  send({ type: "waiting" });
  return delay(...args);
});
syncBuiltinESMExports();
const { ensureDaemonRunning } = await import("../../../extensions/telegram/startup.js");

process.on(
  "message",
  (message: {
    id: number;
    action: string;
    automatic?: boolean;
    ms?: number;
    pid?: number;
    method?: string;
  }) => {
    void control(message).then(
      (result) => {
        send({ type: "controlled", id: message.id, result });
        if (message.action === "dispose") process.disconnect();
      },
      (error) => send({ type: "control_error", id: message.id, error: String(error) }),
    );
  },
);
async function control({
  action,
  automatic,
  ms,
  pid,
  method,
}: {
  action: string;
  automatic?: boolean;
  ms?: number;
  pid?: number;
  method?: string;
}) {
  if (action === "run") {
    const controller = new AbortController();
    const done = ensureDaemonRunning({
      agentDir,
      daemonPath,
      entrypoint: "fixture",
      automatic,
      signal: controller.signal,
    }).catch((error) => String(error));
    operations.push({ controller, done });
    return done;
  }
  if (action === "tick") return mock.timers.tick(ms!);
  if (action === "daemon") {
    const child = children.find((child) => child.pid === pid);
    assert.ok(child?.connected);
    child.send({ action: method });
  } else if (action === "dispose") {
    for (const operation of operations) operation.controller.abort();
    await Promise.resolve();
    mock.timers.tick(1_000);
    await Promise.all(operations.map(({ done }) => done));
    for (const child of children) {
      try {
        child.ref();
        process.kill(-child.pid!, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await Promise.all(exits);
    assert.deepEqual(failures, []);
  } else throw new Error(`Unexpected coordinator action: ${action}`);
}
send({ type: "window_ready" });
