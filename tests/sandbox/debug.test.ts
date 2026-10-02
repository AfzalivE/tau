import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";
import {
  createAgentSession,
  getAgentDir,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { createPiResources, fixtureModel, isolatePiHome, uiBoundary } from "../helpers/pi.js";

describe("sandbox debug commands", { concurrency: false }, () => {
  let home: Awaited<ReturnType<typeof isolatePiHome>>;
  let sandbox: ExtensionFactory;
  let cwd: string;
  let configPath: string;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let failures: unknown[];
  let notifications: string[];
  let inheritedDebug: string | undefined;
  let originalError: typeof console.error;
  let originalWarn: typeof console.warn;
  const configBytes = JSON.stringify({ enabled: false });

  before(async () => {
    home = await isolatePiHome();
    // Sandbox defaults resolve the agent directory at import time.
    ({ default: sandbox } = await import("../../extensions/sandbox/index.js"));
  });

  after(async () => home.dispose());

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "tau-sandbox-debug-"));
    configPath = path.join(getAgentDir(), "sandbox.json");
    await mkdir(getAgentDir(), { recursive: true });
    // Commands and debug capture use the real extension without starting native sandbox services.
    await writeFile(configPath, configBytes);
    inheritedDebug = process.env.SRT_DEBUG;
    delete process.env.SRT_DEBUG;
    originalError = console.error;
    originalWarn = console.warn;
    failures = [];
    notifications = [];
    const resources = await createPiResources(cwd, getAgentDir(), [sandbox]);
    ({ session } = await createAgentSession({
      ...resources,
      model: fixtureModel,
      noTools: "all",
    }));
    await session.bindExtensions({
      mode: "rpc",
      onError: (error) => failures.push(error),
      uiContext: uiBoundary(
        {
          setStatus() {},
          notify(message) {
            notifications.push(message);
          },
        },
        failures,
      ),
    });
  });

  afterEach(async () => {
    try {
      await session?.abort();
      await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      assert.deepEqual(
        failures,
        [],
        "Pi must report unexpected UI operations and extension errors",
      );
      assert.equal(process.env.SRT_DEBUG, undefined);
      assert.equal(console.error, originalError);
      assert.equal(console.warn, originalWarn);
      assert.equal(await readFile(configPath, "utf8"), configBytes);
    } finally {
      session?.dispose();
      session = undefined;
      mock.restoreAll();
      console.error = originalError;
      console.warn = originalWarn;
      if (inheritedDebug === undefined) delete process.env.SRT_DEBUG;
      else process.env.SRT_DEBUG = inheritedDebug;
      await rm(configPath, { force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("debug stays opt-in and accepts case-insensitive toggle aliases without changing config", async () => {
    assert.equal(process.env.SRT_DEBUG, undefined);
    assert.match(await command("doctor"), /Runtime debug logs: disabled/);
    const enabledAliases = ["on", "enable", "enabled", "true"];
    const disabledAliases = ["off", "disable", "disabled", "false"];
    for (const uppercase of [false, true]) {
      for (let index = 0; index < enabledAliases.length; index++) {
        const enabled = enabledAliases[index]!;
        const disabled = disabledAliases[index]!;
        assert.match(
          await command(`debug ${uppercase ? enabled.toUpperCase() : enabled}`),
          /debug logs enabled/,
        );
        assert.equal(process.env.SRT_DEBUG, "1");
        assert.match(
          await command(`debug ${uppercase ? disabled.toUpperCase() : disabled}`),
          /debug logs disabled/,
        );
        assert.equal(process.env.SRT_DEBUG, undefined);
      }
    }
    for (const enabled of [false, true]) {
      await command(`debug ${enabled ? "on" : "off"}`);
      for (const args of ["debug", "debug perhaps", "debug on extra", "debug off extra"]) {
        assert.match(await command(args), /Usage: \/sandbox debug <on\|off>/);
        assert.equal(process.env.SRT_DEBUG, enabled ? "1" : undefined);
      }
    }
  });

  test("doctor shows each captured runtime diagnostic with its capture time", async () => {
    await command("debug on");
    const clock = mock.method(Date, "now", () => new Date(2026, 0, 2, 3, 4, 5).getTime());
    // Substitute runtime diagnostic input only; capture, session commands, and rendering stay real.
    console.error("[SandboxDebug] The kraken proxy is awake");
    clock.mock.mockImplementation(() => new Date(2026, 0, 2, 3, 4, 7).getTime());
    console.warn("[SandboxDebug] Eight sockets are ready");
    clock.mock.restore();
    await command("debug off");

    const report = await command("doctor");
    assert.match(report, /Runtime debug logs: disabled/);
    assert.match(report, /\[03:04:05\] \[SandboxDebug\] The kraken proxy is awake/);
    assert.match(report, /\[03:04:07\] \[SandboxDebug\] Eight sockets are ready/);
  });

  async function command(args: string): Promise<string> {
    const before = notifications.length;
    await session!.prompt(`/sandbox ${args}`);
    return notifications.slice(before).join("\n");
  }
});
