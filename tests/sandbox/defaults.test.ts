import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isolatePiHome } from "../helpers/pi.js";

describe("sandbox platform defaults", { concurrency: false }, () => {
  const originalCwd = process.cwd();
  let home: Awaited<ReturnType<typeof isolatePiHome>>;
  let config: typeof import("../../extensions/sandbox/config.js");
  let directory: string;
  let launcherCwd: string;
  let cwd: string;
  let configPath: string;

  before(async () => {
    home = await isolatePiHome();
    config = await import("../../extensions/sandbox/config.js");
    configPath = path.join(getAgentDir(), "sandbox.json");
  });

  after(async () => home.dispose());

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tau-sandbox-defaults-"));
    launcherCwd = path.join(directory, "shell dock");
    cwd = path.join(directory, "octopus session");
    await mkdir(launcherCwd);
    await mkdir(cwd);
    process.chdir(launcherCwd);
    await mkdir(getAgentDir(), { recursive: true });
  });

  afterEach(async () => {
    try {
      await SandboxManager.reset();
    } finally {
      process.chdir(originalCwd);
      await rm(configPath, { force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("native watching is a macOS default, while explicit service restrictions still replace defaults", async () => {
    const defaults = config.loadConfig(cwd).config;
    const runtime = config.toRuntimeConfig(defaults, cwd);
    assert.ok(runtime.filesystem.allowWrite.includes(cwd));
    assert.ok(!runtime.filesystem.allowWrite.includes(launcherCwd));
    assert.ok(runtime.filesystem.denyWrite.includes(path.join(cwd, ".env")));
    assert.ok(runtime.filesystem.denyWrite.includes(path.join(cwd, ".env.*")));
    assert.equal(
      defaults.network.allowMachLookup?.includes("com.apple.FSEvents"),
      process.platform === "darwin",
    );
    const override = { network: { allowMachLookup: [] } };
    await writeFile(configPath, JSON.stringify(override));
    const restricted = config.loadConfig(cwd).config;
    assert.deepEqual(restricted, {
      ...defaults,
      network: { ...defaults.network, allowMachLookup: [] },
    });
  });

  // Native Seatbelt behavior, not the scripted OS boundary in sandbox.test.ts.
  if (process.platform === "darwin") {
    for (const restricted of [false, true]) {
      test(`recursive watching ${restricted ? "respects an explicit service restriction" : "receives nested file changes"} without opening protected files`, async () => {
        const settings = {
          network: {
            allowedDomains: [],
            allowUnixSockets: [],
            ...(restricted ? { allowMachLookup: [] } : {}),
          },
          filesystem: { allowWrite: ["."], allowTempDirs: false, allowGitCommonDir: false },
        };
        await writeFile(configPath, JSON.stringify(settings));
        const runtime = config.toRuntimeConfig(config.loadConfig(cwd).config, cwd);
        const watchDirectory = path.join(cwd, "octopus nursery");
        const changedFile = path.join(watchDirectory, "nest", "egg.txt");
        const keyFile = path.join(os.homedir(), ".ssh", "nursery-key");
        const protectedFile = path.join(cwd, ".env");
        const protectedGlobFile = path.join(cwd, ".env.tide");
        const launcherFile = path.join(launcherCwd, "dock log.txt");
        await mkdir(path.dirname(changedFile), { recursive: true });
        await mkdir(path.dirname(keyFile), { recursive: true });
        await writeFile(keyFile, "synthetic secret\n");
        await writeFile(protectedFile, "INK=indigo\n");
        await writeFile(protectedGlobFile, "TIDE=hidden\n");
        await writeFile(launcherFile, "The launcher stays ashore.\n");
        try {
          // No OS log monitor or external requests; the child exercises actual enforcement.
          await SandboxManager.initialize(runtime, undefined, false);
          const result = await runWatcher(cwd, watchDirectory, changedFile, keyFile, launcherFile);
          assert.equal(result.code, restricted ? 1 : 0, result.stderr);
          assert.ok(result.stdout.includes("BOUND\n"), result.stdout);
          assert.ok(result.stdout.includes("PROTECTED\n"), result.stdout);
          if (restricted) {
            assert.ok(result.stdout.includes("WATCH_FAILED\n"), result.stdout);
            assert.ok(!result.stdout.includes("OBSERVED\n"), result.stdout);
          } else {
            assert.ok(result.stdout.includes("OBSERVED\n"), result.stdout);
          }
          assert.equal(await readFile(path.join(cwd, "nursery log.txt"), "utf8"), "eight eggs\n");
          assert.equal(await readFile(launcherFile, "utf8"), "The launcher stays ashore.\n");
          assert.equal(await readFile(protectedFile, "utf8"), "INK=indigo\n");
          assert.equal(await readFile(protectedGlobFile, "utf8"), "TIDE=hidden\n");
        } finally {
          await rm(keyFile, { force: true });
        }
      });
    }
  }
});

/** Run a real sandboxed Node watcher; change the nested file only after readiness and join exit. */
async function runWatcher(
  cwd: string,
  directory: string,
  changedFile: string,
  keyFile: string,
  launcherFile: string,
) {
  const fixture = fileURLToPath(new URL("./fixtures/watch.mjs", import.meta.url));
  const command = [process.execPath, fixture, directory, keyFile, launcherFile]
    .map((value) => `'${value.replaceAll("'", "'\\''")}'`)
    .join(" ");
  const wrapped = await SandboxManager.wrapWithSandboxArgv(
    command,
    "/bin/bash",
    undefined,
    undefined,
    cwd,
  );
  const child = spawn(wrapped.argv[0]!, wrapped.argv.slice(1), {
    cwd,
    env: { ...process.env, CFFIXED_USER_HOME: os.homedir(), ...wrapped.env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let onReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    onReady = resolve;
  });
  let stdout = "";
  let stderr = "";
  let error: Error | undefined;
  let closed = false;
  let timedOut = false;
  child.stdout.on("data", (data) => {
    stdout += data;
    if (stdout.includes("READY\n")) onReady();
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  child.once("error", (cause) => {
    error = cause;
  });
  const completion = new Promise<number | null>((resolve) => {
    child.once("close", (code) => {
      closed = true;
      resolve(code);
    });
  });
  const stop = () => {
    if (closed || child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
    }
  };
  const deadline = setTimeout(() => {
    timedOut = true;
    stop();
  }, 10_000);
  try {
    await Promise.race([ready, completion]);
    if (!closed) await writeFile(changedFile, "eight tiny otters\n");
    const code = await completion;
    if (error) throw error;
    assert.equal(timedOut, false, `Native watcher did not finish: ${stderr}`);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(deadline);
    stop();
    await completion;
    SandboxManager.cleanupAfterCommand();
  }
}
