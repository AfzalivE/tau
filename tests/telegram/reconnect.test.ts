import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { deadline } from "../helpers/async.js";
import type {} from "./fixtures/reconnect.js";

type FixtureEvent = {
  type: string;
  id?: number;
  pid?: number;
  signal?: string;
  error?: string;
  result?: boolean | string;
  message?: { type: string };
};

describe("Telegram startup coordinator", { concurrency: false }, () => {
  let directory: string;
  let agentDir: string;
  let now: number;
  let windows: Awaited<ReturnType<typeof startCoordinator>>[];
  let launches: { window: (typeof windows)[number]; pid: number }[];
  let changes: EventEmitter;

  beforeEach(async () => {
    directory = await realpath(await mkdtemp("/tmp/tau-reconnect-"));
    agentDir = path.join(directory, "agent");
    await mkdir(agentDir);
    // Real lock mtimes must remain ahead of the controlled clock, even after repeated cooldowns.
    now = Date.now() - 1_000_000;
    windows = [];
    launches = [];
    changes = new EventEmitter();
  });

  afterEach(async () => {
    const failures: unknown[] = [];
    const results = await Promise.allSettled(windows.map((window) => window.dispose()));
    for (const result of results) if (result.status === "rejected") failures.push(result.reason);
    for (const { pid } of launches) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") failures.push(error);
      }
    }
    await rm(directory, { recursive: true, force: true });
    if (failures.length) throw new AggregateError(failures, "Coordinator cleanup failed");
  });

  test("elects across processes, persists capped 5/20/60/60 cooldowns across replacement, and recovers automatically", async () => {
    const otter = await open();
    let owl = await open();
    let runs = [otter, owl].map((window) => ({
      window,
      done: window.begin("run", { automatic: true }),
    }));
    for (const [index, cooldown] of [5_000, 20_000, 60_000, 60_000].entries()) {
      await waitLaunch(index + 1);
      const launch = launches[index]!;
      assert.equal(await runs.find(({ window }) => window !== launch.window)!.done, false);
      await command(launch, "fail");
      assert.match(
        String(await runs.find(({ window }) => window === launch.window)!.done),
        /exited before becoming ready/,
      );
      const retryAt = now + cooldown;
      assert.deepEqual(await retryState(), { failures: Math.min(index + 1, 3), retryAt });
      await assertUnlocked();

      if (index === 1) {
        await owl.dispose();
        windows = windows.filter((window) => window !== owl);
        owl = await open();
      }
      await advanceTo(retryAt - 1);
      assert.deepEqual(
        await Promise.all([otter, owl].map((window) => window.begin("run", { automatic: true }))),
        [false, false],
      );
      assert.equal(launches.length, index + 1, "neither process launches during shared cooldown");
      await advanceTo(retryAt);
      runs = [otter, owl].map((window) => ({
        window,
        done: window.begin("run", { automatic: true }),
      }));
    }
    await waitLaunch(5);
    const owner = launches[4]!;
    assert.equal(await runs.find(({ window }) => window !== owner.window)!.done, false);
    await command(owner, "ready");
    assert.equal(await runs.find(({ window }) => window === owner.window)!.done, true);
    assert.equal(await retryState(), undefined);
    assert.deepEqual(
      await Promise.all([otter, owl].map((window) => window.begin("run", { automatic: true }))),
      [true, true],
    );
    assert.equal(
      launches.length,
      5,
      "automatic recovery needs no manual command or duplicate daemon",
    );
  });

  test("manual startup bypasses cooldown, but waits for a competing owner instead of bypassing its lock", async () => {
    const otter = await open();
    const owl = await open();
    const failed = otter.begin("run", { automatic: true });
    await waitLaunch(1);
    await command(launches[0]!, "fail");
    assert.match(String(await failed), /exited before becoming ready/);
    assert.deepEqual(await retryState(), { failures: 1, retryAt: now + 5_000 });

    const owner = otter.begin("run");
    await waitLaunch(2);
    let settled = false;
    const waiter = owl.begin("run").then((result) => {
      settled = true;
      return result;
    });
    await owl.waitEvent("waiting");
    assert.equal(settled, false);
    assert.equal(launches.length, 2);
    await command(launches[1]!, "ready");
    assert.equal(await owner, true);
    await advanceTo(now + 100);
    assert.equal(await waiter, true);
    assert.equal(launches.length, 2);
    assert.equal(await retryState(), undefined);
    await assertUnlocked();
  });

  for (const ignoresTerm of [false, true]) {
    test(`10-second readiness deadline ${ignoresTerm ? "escalates TERM after 1 second" : "joins TERM cleanup"}, then permits automatic recovery`, async () => {
      const otter = await open();
      const startup = otter.begin("run", { automatic: true });
      await waitLaunch(1);
      const launch = launches[0]!;
      await booted(launch);
      if (ignoresTerm) {
        await command(launch, "ignore-term");
        await otter.waitEvent(
          "daemon_message",
          (event) => event.message?.type === "fixture_ignoring_term",
        );
      }
      await advanceTo(now + 9_999);
      assert.ok(!otter.events.some((event) => event.type === "daemon_closed"));
      await access(path.join(agentDir, "run", "telegram-startup.json.lock"));
      await advanceTo(now + 1);
      if (ignoresTerm) {
        await otter.waitEvent("daemon_message", (event) => event.message?.type === "fixture_term");
        await advanceTo(now + 999);
        assert.ok(!otter.events.some((event) => event.type === "daemon_closed"));
        await access(path.join(agentDir, "run", "telegram-startup.json.lock"));
        await advanceTo(now + 1);
      }
      assert.match(String(await startup), /startup timed out/);
      assert.equal(
        (await otter.waitEvent("daemon_closed")).signal,
        ignoresTerm ? "SIGKILL" : "SIGTERM",
      );
      await assertUnlocked();
      assert.deepEqual(await retryState(), { failures: 1, retryAt: now + 5_000 });
      assert.equal(await otter.begin("run", { automatic: true }), false);
      await advanceTo(now + 5_000);
      const retry = otter.begin("run", { automatic: true });
      await waitLaunch(2);
      await command(launches[1]!, "ready");
      assert.equal(await retry, true);
      assert.equal(await retryState(), undefined);
    });
  }

  async function open() {
    const window = await startCoordinator(agentDir, now);
    windows.push(window);
    window.onLaunch((pid) => {
      launches.push({ window, pid });
      changes.emit("change");
    });
    return window;
  }
  const waitLaunch = (count: number) =>
    observe(changes, () => launches.length >= count, `launch ${count}`);
  const booted = (launch: (typeof launches)[number]) =>
    launch.window.waitEvent(
      "daemon_message",
      (event) => event.pid === launch.pid && event.message?.type === "fixture_booted",
    );
  async function command(launch: (typeof launches)[number], method: string) {
    await booted(launch);
    await launch.window.begin("daemon", { pid: launch.pid, method });
  }
  async function advanceTo(target: number) {
    const ms = target - now;
    assert.ok(ms >= 0);
    now = target;
    await Promise.all(windows.map((window) => window.begin("tick", { ms })));
  }
  async function retryState() {
    try {
      return JSON.parse(
        await readFile(path.join(agentDir, "run", "telegram-startup.json"), "utf8"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  async function assertUnlocked() {
    await assert.rejects(access(path.join(agentDir, "run", "telegram-startup.json.lock")), {
      code: "ENOENT",
    });
  }
});

/** Commands await exported coordinator operations, not inferred filesystem quiescence. */
async function startCoordinator(agentDir: string, now: number) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./fixtures/reconnect.js", import.meta.url))],
    {
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        TELEGRAM_RECONNECT_NOW: String(now),
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  const events: FixtureEvent[] = [];
  const changes = new EventEmitter();
  let stderr = "";
  let id = 0;
  let disposed = false;
  let exited = false;
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => {
      exited = true;
      changes.emit("change");
      resolve();
    }),
  );
  child.stderr!.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.on("message", (event: FixtureEvent) => {
    events.push(event);
    changes.emit("change");
  });
  const waitEvent = async (
    type: string,
    predicate: (event: FixtureEvent) => boolean = () => true,
  ) => {
    await observe(
      changes,
      () => {
        const failure = events.find((event) => event.type === "control_error");
        return failure
          ? new Error(failure.error)
          : events.some((event) => event.type === type && predicate(event)) ||
              (exited ? new Error(stderr || "Coordinator exited") : false);
      },
      type,
    );
    return events.find((event) => event.type === type && predicate(event))!;
  };
  const begin = async (action: string, options = {}) => {
    const commandId = ++id;
    child.send({ id: commandId, action, ...options });
    const event = await waitEvent("controlled", (event) => event.id === commandId);
    return event.result!;
  };
  const window = {
    events,
    begin,
    waitEvent,
    onLaunch(callback: (pid: number) => void) {
      child.on("message", (event: FixtureEvent) => {
        if (event.type === "launch") callback(event.pid!);
      });
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        if (!exited) await begin("dispose");
        await deadline(closed, "coordinator close");
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
