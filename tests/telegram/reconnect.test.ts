import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { deadline } from "../helpers/async.js";
import type {} from "./fixtures/reconnect.js";

const fixturePath = fileURLToPath(new URL("./fixtures/reconnect.js", import.meta.url));
type FixtureEvent = {
  type: string;
  id?: number;
  pid?: number;
  code?: number;
  signal?: string;
  error?: string;
  message?: { type: string };
  probeCount?: number;
  configReads?: number;
  configWrites?: number;
  failures?: string[];
};

describe("Telegram automatic reconnect coordination", { concurrency: false }, () => {
  let directory: string;
  let agentDir: string;
  let baseline: number;
  let now: number;
  let windows: Awaited<ReturnType<typeof startWindow>>[];
  let launches: { window: Awaited<ReturnType<typeof startWindow>>; pid: number }[];
  let changes: EventEmitter;

  beforeEach(async () => {
    // Short canonical paths also fit macOS's Unix socket limit.
    directory = await realpath(await mkdtemp("/tmp/tau-reconnect-"));
    agentDir = path.join(directory, "agent");
    await mkdir(path.join(agentDir, "telegram"), { recursive: true });
    await writeFile(
      path.join(agentDir, "telegram", "config.json"),
      JSON.stringify({ pairedChatId: 42 }),
    );
    // Controlled time stays behind kernel time: freshly mkdir'ed lock directories receive real
    // mtimes, and must not look stale merely because the test advances Date without wall time.
    baseline = now = Date.now() - 1_000_000;
    windows = [];
    launches = [];
    changes = new EventEmitter();
  });

  afterEach(async () => {
    const failures: unknown[] = [];
    try {
      await Promise.all(windows.map((window) => window.dispose()));
    } catch (error) {
      failures.push(error);
    } finally {
      // A failed assertion or crashed window must not orphan its detached protocol child.
      const pids = new Set([
        ...launches.map(({ pid }) => pid),
        ...windows.flatMap((window) =>
          window.events.filter(({ type }) => type === "external_launch").map(({ pid }) => pid!),
        ),
      ]);
      for (const pid of pids) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") failures.push(error);
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
    if (failures.length) throw new AggregateError(failures, "Reconnect fixture cleanup failed");
  });

  test("shares 5/20/60-second capped cooldowns across processes and reloads, then recovers without /pair", async () => {
    const otter = await open("otter");
    let owl = await open("owl");
    await waitLaunch(1);
    await flush();
    assert.equal(launches.length, 1, "two real Pi processes must elect only one startup owner");

    for (const [index, cooldown] of [5_000, 20_000, 60_000, 60_000].entries()) {
      const launch = launches[index]!;
      await fail(launch);
      const retryAt = now + cooldown;
      assert.deepEqual(await retryState(), { failures: Math.min(index + 1, 3), retryAt });
      await assertUnlocked();

      if (index === 1) {
        await otter.control("reload");
        await owl.dispose();
        windows = windows.filter((window) => window !== owl);
        owl = await open("replacement-owl");
        await flush();
        assert.equal(launches.length, 2, "reload and a new process must retain shared cooldown");
      }

      await advanceTo(retryAt - 1);
      assert.equal(launches.length, index + 1, "no startup before the shared retry deadline");
      const nextTick = baseline + Math.ceil((retryAt - baseline) / 3_000) * 3_000;
      if (nextTick > retryAt) {
        await advanceTo(nextTick - 1);
        assert.equal(launches.length, index + 1, "deadline alone does not bypass 3-second polling");
      }
      await advanceTo(nextTick);
      await waitLaunch(index + 2);
      await flush();
      assert.equal(launches.length, index + 2, "only one process retries on the eligible tick");
    }

    await ready(launches[4]!);
    await advanceTo(now + 3_000);
    await Promise.all([otter.waitEvent("registered"), owl.waitEvent("registered")]);
    await flush();
    assert.equal(await retryState(), undefined, "successful readiness clears failure history");
    assert.deepEqual((await otter.snapshot()).failures, []);
    assert.deepEqual((await owl.snapshot()).failures, []);
    assert.equal(launches.length, 5, "recovery needs no manual command or duplicate daemon");
  });

  test("manual /pair bypasses cooldown but joins another process's in-flight startup", async () => {
    const otter = await open("otter");
    const owl = await open("owl");
    await waitLaunch(1);
    await flush();
    await fail(launches[0]!);
    assert.deepEqual(await retryState(), { failures: 1, retryAt: baseline + 5_000 });

    const firstPair = otter.begin("pair");
    await waitLaunch(2);
    assert.equal(now, baseline, "explicit pairing may start before the cooldown deadline");
    const secondPair = owl.begin("pair");
    await flush();
    assert.equal(launches.length, 2, "manual pairing cannot bypass the cross-process lock");
    assert.ok(
      !owl.events.some((event) => event.type === "controlled" && event.id === secondPair.id),
    );

    await ready(launches[1]!);
    // Let the waiting window's lock-check timer observe readiness, without reaching the old cooldown.
    await advanceTo(baseline + 3_000);
    await Promise.all([firstPair.done, secondPair.done]);
    await Promise.all([otter.waitEvent("registered"), owl.waitEvent("registered")]);
    await flush();
    assert.equal(launches.length, 2);
    assert.equal(await retryState(), undefined);
    await assertUnlocked();
  });

  test("registration to an independently started daemon clears shared cooldown without another launch", async () => {
    const otter = await open("otter");
    await waitLaunch(1);
    await fail(launches[0]!);
    assert.deepEqual(await retryState(), { failures: 1, retryAt: baseline + 5_000 });

    await otter.control("external-daemon");
    const external = { window: otter, pid: (await otter.waitEvent("external_launch")).pid! };
    await booted(external);
    await otter.control("ready", { pid: external.pid });
    await otter.waitEvent("daemon_message", (event) => event.message?.type === "telegram_ready");
    await advanceTo(baseline + 3_000);
    await otter.waitEvent("registered");
    await flush();

    assert.equal(
      launches.length,
      1,
      "a cheap socket probe joins the independent daemon during cooldown",
    );
    assert.equal(
      await retryState(),
      undefined,
      "registration resets failure history even without owned startup",
    );
    await assertUnlocked();
    assert.deepEqual((await otter.snapshot()).failures, []);
  });

  for (const action of ["fail", "shutdown"] as const) {
    test(`${action} kills TERM-ignoring credential descendants after the daemon leader exits`, async () => {
      const descendant = await descendantBoundary(directory);
      try {
        const otter = await open("otter");
        await waitLaunch(1);
        const launch = launches[0]!;
        await booted(launch);
        await otter.control("spawn-descendant", { pid: launch.pid });
        await descendant.ready();

        if (action === "fail") await fail(launch);
        else await otter.control("shutdown");
        await otter.waitEvent("daemon_closed", (event) => event.pid === launch.pid);
        await descendant.waitDead();
        await assertUnlocked();

        const owl = await open("owl");
        await flush();
        assert.equal(launches.length, 1);
        const pair = owl.begin("pair");
        await waitLaunch(2);
        await ready(launches[1]!);
        await pair.done;
        assert.equal(launches.length, 2, "the next owner starts only after descendant cleanup");
      } finally {
        await descendant.dispose();
      }
    });
  }

  for (const action of ["shutdown", "unpair"] as const) {
    test(`${action} cancels and joins a held startup, releases its lock and never resurrects reconnects`, async () => {
      const otter = await open("otter");
      await waitLaunch(1);
      const launch = launches[0]!;
      await booted(launch);
      await otter.control(action);
      assert.ok(
        otter.events.some((event) => event.type === "daemon_closed" && event.pid === launch.pid),
        "lifecycle completion must join the canceled child's close event",
      );
      await flush();
      await assertUnlocked();
      assert.throws(
        () => process.kill(launch.pid, 0),
        (error: NodeJS.ErrnoException) => error.code === "ESRCH",
      );
      const before = await otter.snapshot();
      await advanceTo(baseline + 30_000);
      const after = await otter.snapshot();
      assert.equal(launches.length, 1, "canceled work cannot revive a daemon");
      assert.equal(after.probeCount, before.probeCount, "no socket work after shutdown or unpair");
      assert.deepEqual(after.failures, []);
    });
  }

  for (const ignoresTerm of [false, true]) {
    test(`bounds absent readiness at 10 seconds, ${ignoresTerm ? "escalates TERM after 1 second" : "joins TERM cleanup"}, and retries automatically`, async () => {
      const otter = await open("otter");
      await waitLaunch(1);
      const launch = launches[0]!;
      await booted(launch);
      if (ignoresTerm) {
        await otter.control("ignore-term", { pid: launch.pid });
        await otter.waitEvent(
          "daemon_message",
          (event) => event.message?.type === "fixture_ignoring_term",
        );
      }
      await advanceTo(baseline + 9_999);
      assert.ok(!otter.events.some((event) => event.type === "daemon_closed"));
      await access(path.join(agentDir, "run", "telegram-startup.json.lock"));

      await advanceTo(baseline + 10_000);
      if (ignoresTerm) {
        await otter.waitEvent("daemon_message", (event) => event.message?.type === "fixture_term");
        await advanceTo(baseline + 10_999);
        assert.ok(!otter.events.some((event) => event.type === "daemon_closed"));
        await access(path.join(agentDir, "run", "telegram-startup.json.lock"));
        await advanceTo(baseline + 11_000);
      }
      const closed = await otter.waitEvent("daemon_closed");
      assert.equal(closed.signal, ignoresTerm ? "SIGKILL" : "SIGTERM");
      await flush();
      await assertUnlocked();
      const retryAt = now + 5_000;
      assert.deepEqual(await retryState(), { failures: 1, retryAt });
      const nextTick = baseline + Math.ceil((retryAt - baseline) / 3_000) * 3_000;
      await advanceTo(nextTick - 1);
      assert.equal(launches.length, 1);
      await advanceTo(nextTick);
      await waitLaunch(2);
      await ready(launches[1]!);
      assert.equal(await retryState(), undefined);
    });
  }

  for (const unpairFirst of [false, true]) {
    test(`single-flights before config IO and joins ${unpairFirst ? "pending unpair plus shutdown" : "shutdown"} while that IO is blocked`, async () => {
      const otter = await open("otter", true);
      await otter.waitEvent("config_read");
      await advanceTo(baseline + 9_000);
      const blocked = await otter.snapshot();
      assert.equal(blocked.configReads, 1, "overlapping ticks must not start another config read");
      assert.equal(blocked.probeCount, 0);
      assert.equal(launches.length, 0);

      const unpair = unpairFirst ? otter.begin("unpair") : undefined;
      if (unpair) {
        await otter.control("flush");
        assert.ok(
          !otter.events.some((event) => event.type === "controlled" && event.id === unpair.id),
          "unpair must be waiting for the blocked automatic operation before shutdown starts",
        );
      }
      const shutdown = otter.begin("shutdown");
      await otter.control("flush");
      assert.ok(
        !otter.events.some((event) => event.type === "controlled" && event.id === shutdown.id),
        "shutdown must join the pending automatic operation and unpair",
      );
      await otter.control("release-config");
      await Promise.all([shutdown.done, unpair?.done]);
      await flush();
      await advanceTo(baseline + 30_000);
      const stopped = await otter.snapshot();
      assert.equal(stopped.configReads, 1, "retired operations must not resume config work");
      assert.equal(stopped.configWrites, 0, "retired unpair must not mutate pairing state");
      assert.equal(stopped.probeCount, 0, "cancellation must be rechecked after awaited config IO");
      assert.equal(launches.length, 0);
      assert.equal(
        await readFile(path.join(agentDir, "telegram", "config.json"), "utf8"),
        JSON.stringify({ pairedChatId: 42 }),
      );
      assert.deepEqual(stopped.failures, []);
    });
  }

  async function open(name: string, holdConfig = false) {
    let window: Awaited<ReturnType<typeof startWindow>> | undefined;
    const pending: number[] = [];
    const recordLaunch = (pid: number) => {
      if (!window) {
        pending.push(pid);
        return;
      }
      launches.push({ window, pid });
      changes.emit("change");
    };
    window = await startWindow(directory, agentDir, name, now, holdConfig, recordLaunch);
    for (const pid of pending) recordLaunch(pid);
    windows.push(window);
    return window;
  }

  async function waitLaunch(count: number) {
    await observe(changes, () => launches.length >= count, `daemon launch ${count}`);
  }

  async function booted(launch: (typeof launches)[number]) {
    await launch.window.waitEvent(
      "daemon_message",
      (event) => event.pid === launch.pid && event.message?.type === "fixture_booted",
    );
  }

  async function fail(launch: (typeof launches)[number]) {
    await booted(launch);
    await launch.window.control("fail", { pid: launch.pid });
    await launch.window.waitEvent("daemon_closed", (event) => event.pid === launch.pid);
    await flush();
  }

  async function ready(launch: (typeof launches)[number]) {
    await booted(launch);
    await launch.window.control("ready", { pid: launch.pid });
    await launch.window.waitEvent("registered");
    await flush();
  }

  async function flush() {
    await Promise.all(windows.map((window) => window.control("flush")));
  }

  async function advanceTo(target: number) {
    assert.ok(target >= now);
    while (now < target) {
      // Tick each interval boundary: node:test advances Date before dispatching due callbacks.
      const ms = Math.min(target - now, 3_000 - ((now - baseline) % 3_000));
      now += ms;
      await Promise.all(windows.map((window) => window.control("tick", { ms })));
      await flush();
    }
  }

  async function retryState() {
    try {
      return JSON.parse(
        await readFile(path.join(agentDir, "run", "telegram-startup.json"), "utf8"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async function assertUnlocked() {
    await assert.rejects(access(path.join(agentDir, "run", "telegram-startup.json.lock")), {
      code: "ENOENT",
    });
  }
});

/** Separate public-SDK session process. IPC controls clocks and observes the substituted daemon boundary. */
async function startWindow(
  directory: string,
  agentDir: string,
  name: string,
  now: number,
  holdConfig: boolean,
  onLaunch: (pid: number) => void,
) {
  const cwd = path.join(directory, name);
  const home = path.join(directory, "home");
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
  const child = spawn(process.execPath, [fixturePath], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_CACHE_HOME: path.join(home, "cache"),
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_STATE_HOME: path.join(home, "state"),
      PI_CODING_AGENT_DIR: agentDir,
      TAU_SUBAGENT_CHILD: undefined,
      TAU_TELEGRAM_DISABLE: undefined,
      TAU_TELEGRAM_BOT_TOKEN: undefined,
      TELEGRAM_RECONNECT_NOW: String(now),
      TELEGRAM_RECONNECT_HOLD_CONFIG: holdConfig ? "1" : undefined,
      TELEGRAM_RECONNECT_DESCENDANT_SOCKET: path.join(directory, "descendant.sock"),
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const events: FixtureEvent[] = [];
  const changes = new EventEmitter();
  let stderr = "";
  let exited = false;
  let disposing = false;
  let id = 0;
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => {
      exited = true;
      changes.emit("change");
      resolve();
    });
  });
  child.stderr!.on("data", (chunk) => (stderr += String(chunk)));
  child.once("error", (error) => {
    stderr += String(error);
    changes.emit("change");
  });
  child.on("message", (message) => {
    const event = message as FixtureEvent;
    events.push(event);
    if (event.type === "launch") onLaunch(event.pid!);
    changes.emit("change");
  });
  const waitEvent = async (
    type: string,
    predicate: (event: FixtureEvent) => boolean = () => true,
  ) => {
    await observe(
      changes,
      () =>
        events.some((event) => event.type === type && predicate(event)) ||
        (exited ? new Error(`${name} window exited: ${stderr}`) : false),
      `${name}: ${type}`,
    );
    return events.find((event) => event.type === type && predicate(event))!;
  };
  const begin = (action: string, options = {}) => {
    const commandId = ++id;
    child.send({ id: commandId, action, ...options });
    const done = observe(
      changes,
      () => {
        const error = events.find(
          (event) => event.type === "control_error" && event.id === commandId,
        );
        if (error) return new Error(`${name} ${action}: ${error.error}\n${stderr}`);
        return (
          events.some((event) => event.type === "controlled" && event.id === commandId) ||
          (exited ? new Error(`${name} window exited during ${action}: ${stderr}`) : false)
        );
      },
      `${name}: ${action}`,
    );
    return { id: commandId, done };
  };
  const window = {
    events,
    begin,
    waitEvent,
    control: async (action: string, options = {}) => begin(action, options).done,
    async snapshot() {
      const start = events.length;
      await window.control("snapshot");
      return events.slice(start).find((event) => event.type === "snapshot")!;
    },
    async dispose() {
      if (disposing) return;
      disposing = true;
      try {
        if (!exited) await window.control("dispose");
        await deadline(closed, `${name} window close`);
        assert.equal(child.exitCode, 0, stderr);
      } finally {
        if (!exited) child.kill("SIGKILL");
        await closed;
      }
    },
  };
  try {
    await waitEvent("window_ready");
    return window;
  } catch (error) {
    child.kill("SIGKILL");
    await closed;
    throw error;
  }
}

/** Socket EOF proves the credential-like descendant stopped, without mistaking Linux zombies for live work. */
async function descendantBoundary(directory: string) {
  const changes = new EventEmitter();
  let socket: net.Socket | undefined;
  let pid: number | undefined;
  let ended = false;
  let failure: Error | undefined;
  const server = net.createServer((connection) => {
    assert.equal(socket, undefined, "Only one credential descendant is expected");
    socket = connection;
    const lines = createInterface({ input: socket });
    lines.once("line", (line) => {
      pid = Number(line);
      assert.ok(Number.isInteger(pid) && pid > 0);
      changes.emit("change");
    });
    socket.once("error", (error) => {
      failure = error;
      changes.emit("change");
    });
    socket.once("close", () => {
      ended = true;
      lines.close();
      changes.emit("change");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path.join(directory, "descendant.sock"), resolve);
  });
  const waitDead = () => observe(changes, () => failure ?? ended, "credential descendant death");
  return {
    ready: () =>
      observe(changes, () => failure ?? pid !== undefined, "credential descendant ready"),
    waitDead,
    async dispose() {
      try {
        if (pid && !ended) {
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
          await waitDead();
        } else socket?.destroy();
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  };
}

/** Completion signals, not sleeps. The deadline is only a failure safety net. */
async function observe(events: EventEmitter, state: () => boolean | Error, label: string) {
  let check!: () => void;
  try {
    await deadline(
      new Promise<void>((resolve, reject) => {
        check = () => {
          const value = state();
          if (value instanceof Error) reject(value);
          else if (value) resolve();
        };
        events.on("change", check);
        check();
      }),
      label,
    );
  } finally {
    events.removeListener("change", check);
  }
}
