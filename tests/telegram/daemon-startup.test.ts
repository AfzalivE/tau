import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { lstat, mkdir, mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type {} from "./fixtures/daemon-startup.js";

type FixtureEvent = { type: string; pid?: number; code?: number; signal?: string; method?: string };

describe("Telegram daemon startup ownership", () => {
  let directory: string;
  let agentDir: string;
  let children: ReturnType<typeof launch>[];
  let sockets: net.Socket[];
  let replacement: net.Server | undefined;

  beforeEach(async () => {
    directory = await realpath(await mkdtemp("/tmp/tau-tg-"));
    agentDir = path.join(directory, "agent");
    children = [];
    sockets = [];
    await mkdir(path.join(agentDir, "telegram"), { recursive: true });
    await writeConfig(agentDir);
  });

  afterEach(async () => {
    try {
      for (const socket of sockets) socket.destroy();
      const results = await Promise.allSettled(children.map((child) => child.dispose()));
      if (replacement) await new Promise<void>((resolve) => replacement!.close(() => resolve()));
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
      }
    } finally {
      replacement = undefined;
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("launcher disconnect before startup does not begin a credential read", async () => {
    const owner = start("blocked");
    owner.detach();
    await owner.waitClose(0);
    assert.equal(
      owner.events.some((event) => event.type === "credential_started"),
      false,
    );
    assert.deepEqual(owner.messages, []);
    await assertAbsent(socketPath(agentDir));
    await assertAbsent(leasePath(agentDir));
  });

  test("a duplicate starter never reads credentials, and launcher cancellation joins blocked Keychain before releasing ownership", async () => {
    // A fallback token would expose accidental continuation after cancellation.
    await writeConfig(agentDir, true);
    const owner = start("blocked");
    const credential = await owner.waitEvent("credential_started");
    assert.ok(credential.pid);
    await lstat(leasePath(agentDir));

    const duplicate = start("blocked");
    await duplicate.waitClose(0);
    assert.deepEqual(duplicate.events, []);
    assert.deepEqual(duplicate.messages, []);
    assert.match(duplicate.stderr, /already starting or running/);
    await lstat(leasePath(agentDir));

    owner.detach();
    await owner.waitClose(0);
    assert.deepEqual(
      owner.events.filter((event) => event.type === "credential_closed"),
      [{ type: "credential_closed", code: null, signal: "SIGKILL" }],
    );
    assert.deepEqual(owner.messages, []);
    assert.equal(
      owner.events.some((event) => event.type === "request"),
      false,
    );
    assert.throws(() => process.kill(credential.pid!, 0), { code: "ESRCH" });
    await assertAbsent(socketPath(agentDir));
    await assertAbsent(leasePath(agentDir));

    const retry = start("token");
    await retry.waitReady();
    await retry.stop();
  });

  for (const marked of [true, false]) {
    test(`${marked ? "ready handoff" : "unmarked standalone IPC"} survives disconnect without extra readiness messages or socket disruption`, async () => {
      const owner = start("token", marked);
      if (marked) await owner.waitReady();
      else await owner.waitRunning();
      assert.deepEqual(owner.messages, marked ? [{ type: "telegram_ready" }] : []);
      owner.detach();
      await owner.waitEvent("detached");
      const initial = await lstat(socketPath(agentDir));
      const window = await connectWindow(agentDir);
      sockets.push(window.socket);
      assert.equal((await window.register("otter")).sessionNo, 1);

      const duplicate = start("blocked");
      await duplicate.waitClose(0);
      assert.deepEqual(duplicate.events, []);
      assert.deepEqual(duplicate.messages, []);
      assert.equal((await lstat(socketPath(agentDir))).ino, initial.ino);
      assert.equal((await window.register("owl")).sessionNo, 2);

      assert.equal((await window.register("badger")).sessionNo, 3);
      assert.equal((await lstat(socketPath(agentDir))).ino, initial.ino);
      assert.equal(owner.closed, false);
      await owner.stop();
      await assertAbsent(socketPath(agentDir));
      await assertAbsent(leasePath(agentDir));
    });
  }

  test("a healthy live socket without a lease is left untouched before any credential read", async () => {
    await mkdir(path.dirname(socketPath(agentDir)), { recursive: true });
    replacement = net.createServer((socket) => {
      socket.once("data", (bytes) => {
        assert.equal(String(bytes), "?");
        socket.end("otter still owns this socket\n");
      });
    });
    await listen(replacement, socketPath(agentDir));
    const initial = await lstat(socketPath(agentDir));

    const duplicate = start("blocked");
    await duplicate.waitClose(0);
    assert.deepEqual(duplicate.events, []);
    assert.deepEqual(duplicate.messages, []);
    assert.equal((await lstat(socketPath(agentDir))).ino, initial.ino);
    assert.match(duplicate.stderr, /already running/);
    await assertAbsent(leasePath(agentDir));
    const socket = net.connect(socketPath(agentDir));
    sockets.push(socket);
    socket.write("?");
    const [bytes] = await once(socket, "data");
    assert.equal(String(bytes), "otter still owns this socket\n");
  });

  test("stopping an old daemon cannot unlink a replacement socket", async () => {
    const owner = start("token");
    await owner.waitReady();
    await unlink(socketPath(agentDir));
    replacement = net.createServer((socket) => socket.end("badger replacement\n"));
    await listen(replacement, socketPath(agentDir));
    const initial = await lstat(socketPath(agentDir));

    await owner.stop();
    assert.equal((await lstat(socketPath(agentDir))).ino, initial.ino);
    const socket = net.connect(socketPath(agentDir));
    sockets.push(socket);
    const [bytes] = await once(socket, "data");
    assert.equal(String(bytes), "badger replacement\n");
    await assertAbsent(leasePath(agentDir));
  });

  for (const keychain of ["missing", "blocked"] as const) {
    test(`${keychain === "blocked" ? "a 5-second Keychain timeout" : "missing credentials"} fails cleanly and releases the lease without polling`, async () => {
      const owner = start(keychain);
      await owner.waitEvent("credential_started");
      await owner.waitClose(1);
      const closed = owner.events.find((event) => event.type === "credential_closed")!;
      assert.equal(closed.signal, keychain === "blocked" ? "SIGKILL" : null);
      assert.equal(
        owner.events.some((event) => event.type === "request"),
        false,
      );
      assert.deepEqual(owner.messages, []);
      assert.match(owner.stderr, /Missing bot token/);
      if (keychain === "blocked") assert.match(owner.stderr, /Keychain token read timed out/);
      assert.doesNotMatch(owner.stderr, /partial-secret|fixture-token/);
      await assertAbsent(socketPath(agentDir));
      await assertAbsent(leasePath(agentDir));
    });
  }

  function start(keychain: "token" | "blocked" | "missing", marked = true) {
    const child = launch(agentDir, keychain, marked);
    children.push(child);
    return child;
  }
});

/** A real detached daemon. Fixture telemetry uses stderr so it remains observable after IPC handoff. */
function launch(agentDir: string, keychain: string, marked: boolean) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./fixtures/daemon-startup.js", import.meta.url))],
    {
      detached: true,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        TAU_TELEGRAM_BOT_TOKEN: undefined,
        TAU_TELEGRAM_STARTUP: marked ? "1" : undefined,
        TELEGRAM_KEYCHAIN_FIXTURE: keychain,
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  const events: FixtureEvent[] = [];
  const messages: unknown[] = [];
  const changes = new EventEmitter();
  let stderr = "";
  let closed = false;
  const lines = createInterface({ input: child.stderr! });
  lines.on("line", (line) => {
    if (line.startsWith("[fixture] ")) events.push(JSON.parse(line.slice("[fixture] ".length)));
    else stderr += line + "\n";
    changes.emit("change");
  });
  child.on("message", (message) => {
    messages.push(message);
    changes.emit("change");
  });
  child.on("error", (error) => {
    stderr += String(error);
    changes.emit("change");
  });
  // Join the process and owned output independently of IPC's explicit disconnect lifecycle.
  let exited = false;
  let stderrClosed = false;
  const finish = () => {
    closed = exited && stderrClosed;
    changes.emit("change");
  };
  child.once("exit", () => {
    exited = true;
    finish();
  });
  child.stderr!.once("close", () => {
    stderrClosed = true;
    lines.close();
    finish();
  });
  const wait = (state: () => boolean) =>
    observe(
      changes,
      () => state() || (closed ? new Error(stderr || "Daemon closed unexpectedly") : false),
    );
  const daemon = {
    events,
    messages,
    get stderr() {
      return stderr;
    },
    get closed() {
      return closed;
    },
    detach() {
      child.disconnect();
    },
    async waitReady() {
      await wait(() => messages.length > 0);
      assert.deepEqual(messages, [{ type: "telegram_ready" }]);
    },
    async waitRunning() {
      await wait(() => stderr.includes("Daemon running."));
    },
    async waitEvent(type: string) {
      await wait(() => events.some((event) => event.type === type));
      return events.find((event) => event.type === type)!;
    },
    async waitClose(code: number) {
      await observe(changes, () => closed).catch((error) => {
        throw new Error(
          `Daemon did not close: ${stderr}\n${JSON.stringify({ events, messages, exitCode: child.exitCode, signal: child.signalCode })}`,
          { cause: error },
        );
      });
      assert.equal(child.exitCode, code, stderr);
      assert.equal(child.signalCode, null, stderr);
    },
    async stop() {
      child.kill("SIGTERM");
      await daemon.waitClose(0);
    },
    async dispose() {
      if (!closed) {
        const deadline = setTimeout(() => child.kill("SIGKILL"), 8_000);
        try {
          await daemon.stop();
        } finally {
          clearTimeout(deadline);
        }
      }
      assert.doesNotMatch(stderr, /AssertionError|Unexpected|unhandled/i);
    },
  };
  return daemon;
}

function socketPath(agentDir: string) {
  return path.join(agentDir, "run", "telegram.sock");
}
function leasePath(agentDir: string) {
  return path.join(agentDir, "run", "telegram.daemon.lock");
}

async function writeConfig(agentDir: string, fallback = false) {
  await writeFile(
    path.join(agentDir, "telegram", "config.json"),
    JSON.stringify({
      pairedChatId: 42,
      ...(fallback ? { botToken: "fixture-token" } : {}),
    }),
  );
}

async function assertAbsent(file: string) {
  await assert.rejects(lstat(file), { code: "ENOENT" });
}

async function listen(server: net.Server, socket: string) {
  const listening = once(server, "listening");
  server.listen(socket);
  await listening;
}

/** Minimal window client, checking that the same connected daemon remains usable through handoff. */
async function connectWindow(agentDir: string) {
  const socket = net.connect(socketPath(agentDir));
  const lines = createInterface({ input: socket });
  const connected = once(socket, "connect");
  socket.once("close", () => lines.close());
  await connected;
  return {
    socket,
    async register(windowId: string) {
      const reply = once(lines, "line");
      socket.write(
        JSON.stringify({ type: "register", windowId, sessionId: windowId, cwd: agentDir }) + "\n",
      );
      const [line] = await reply;
      const registered = JSON.parse(line);
      assert.equal(registered.type, "registered");
      return registered as { sessionNo: number };
    },
  };
}

/** Wait only on protocol/lifecycle completion. The timer is a failure bound, not synchronization. */
function observe(events: EventEmitter, state: () => boolean | Error): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(deadline);
      events.off("change", check);
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      const value = state();
      if (value instanceof Error) finish(value);
      else if (value) finish();
    };
    const deadline = setTimeout(() => finish(new Error("Daemon startup protocol stalled")), 10_000);
    events.on("change", check);
    check();
  });
}
