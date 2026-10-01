import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { failureExitCode, parseOptions } from "./sandbox-run.mjs";

const runner = fileURLToPath(new URL("../bin/sandbox-run", import.meta.url));
const canRunSandbox =
  !process.env.SANDBOX_RUNTIME && ["darwin", "linux"].includes(process.platform);
const nativeSkip = canRunSandbox
  ? false
  : "Requires a normal macOS/Linux terminal outside an existing sandbox";

function fixture(t, config = {}) {
  const root = mkdtempSync(join(tmpdir(), "tau-sandbox-run-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "work");
  const agentDir = join(root, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  const configPath = join(root, "sandbox.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      commands: { blocked: [], excluded: [], exclusionsEnabled: false },
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: [], allowWrite: ["."], denyWrite: [] },
      ...config,
    }),
  );
  return { root, cwd, agentDir, configPath };
}

function run(f, args, { config = true } = {}) {
  const result = spawnSync(
    runner,
    ["--cwd", f.cwd, ...(config ? ["--config", f.configPath] : []), ...args],
    {
      env: { ...process.env, PI_CODING_AGENT_DIR: f.agentDir },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

function audit(f) {
  const directory = join(f.agentDir, "logs", "sandbox");
  return readdirSync(directory).flatMap((name) =>
    readFileSync(join(directory, name), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  );
}

test("argv quoting preserves literal arguments without shell expansion", () => {
  const args = ["two words", "", "quote'quote", "$HOME", "$(printf injected)", "a;b", "a\nb", "\\"];
  const options = parseOptions(["--", "printf", "%s\\0", ...args]);
  const result = spawnSync("/bin/bash", ["-c", options.command], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.deepEqual(result.stdout.split("\0").slice(0, -1), args);
});

test("shell command is retained verbatim and config paths use the launch cwd", (t) => {
  const f = fixture(t);
  const command = "printf '%s' hello | wc -c > result.txt";
  const options = parseOptions([
    "--cwd",
    f.cwd,
    "--config",
    "policy.json",
    "--timeout",
    "1.5",
    "-c",
    command,
  ]);
  assert.equal(options.command, command);
  assert.equal(options.config, resolve("policy.json"));
  assert.equal(options.cwd, realpathSync(f.cwd));
  assert.equal(options.timeout, 1.5);
});

test("invalid arguments fail before command execution", () => {
  for (const args of [
    [],
    ["-c", " "],
    ["-c", "true", "--", "false"],
    ["--unknown"],
    ...["0", "-1", "NaN", "Infinity", "2147484"].map((timeout) => [
      "--timeout",
      timeout,
      "-c",
      "true",
    ]),
  ]) {
    assert.throws(() => parseOptions(args), undefined, JSON.stringify(args));
  }
  assert.deepEqual(parseOptions(["--help", "--cwd", "/missing/directory"]), { help: true });
});

test("Pi failure status is read only from its final status line", () => {
  assert.equal(failureExitCode("output\n\nCommand exited with code 37"), 37);
  assert.equal(failureExitCode("Command exited with code 0"), 1);
  assert.equal(failureExitCode("Command exited with code 999"), 1);
  assert.equal(failureExitCode("Command exited with code 37\nother error"), 1);
  assert.equal(failureExitCode("output\n\nCommand timed out after 0.5 seconds"), 124);
  assert.equal(failureExitCode("output\n\nCommand aborted"), 130);
});

test("disabled configuration cannot fall back to unsandboxed Bash", (t) => {
  const f = fixture(t, { enabled: false });
  const marker = join(f.cwd, "executed");
  const result = run(f, ["-c", "printf bad > executed"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Sandbox is required but is not active \(config-disabled\)/);
  assert.equal(existsSync(marker), false);
  assert.match(result.stderr, /Sandbox audit log:/);
  const records = audit(f);
  assert(records.some((record) => record.type === "session-start"));
  assert(records.some((record) => record.type === "session-stop" && record.data.reason === "quit"));
  assert.equal(existsSync(join(f.agentDir, "sessions")), false);
  assert.equal(existsSync(join(f.agentDir, "auth.json")), false);
});

test("tool-call preflight enforces commands.blocked", (t) => {
  const f = fixture(t, { enabled: false, commands: { blocked: ["printf"] } });
  const result = run(f, ["-c", "printf bad > executed"]);
  assert.equal(result.status, 126);
  assert.match(result.stdout, /blocked/i);
  assert.equal(existsSync(join(f.cwd, "executed")), false);
});

test("explicit invalid and missing configs fail closed", (t) => {
  const f = fixture(t);
  for (const contents of ["{ invalid", "[]", "null", "42"]) {
    writeFileSync(f.configPath, contents);
    const result = run(f, ["-c", "printf bad > executed"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /config|configuration/i);
    assert.equal(existsSync(join(f.cwd, "executed")), false);
  }
  rmSync(f.configPath);
  assert.equal(run(f, ["-c", "printf bad > executed"]).status, 1);
  assert.equal(existsSync(join(f.cwd, "executed")), false);
});

test("invalid default config cannot silently use default policy", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.agentDir, "sandbox.json"), "{ invalid");
  const result = run(f, ["-c", "printf bad > executed"], { config: false });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /refusing to run with invalid configuration/);
  assert.equal(existsSync(join(f.cwd, "executed")), false);
});

test("project policy requires trust, and trusted project extensions still stay unloaded", async (t) => {
  const f = fixture(t);
  writeFileSync(
    join(f.agentDir, "sandbox.json"),
    JSON.stringify({ enabled: false, commands: { blocked: [] } }),
  );
  mkdirSync(join(f.cwd, ".pi", "extensions"), { recursive: true });
  writeFileSync(
    join(f.cwd, ".pi", "sandbox.json"),
    JSON.stringify({ commands: { blocked: ["printf"] } }),
  );
  writeFileSync(
    join(f.cwd, ".pi", "extensions", "unexpected.ts"),
    "throw new Error('PROJECT_EXTENSION_LOADED');",
  );
  assert.equal(run(f, ["-c", "printf hello"], { config: false }).status, 1);
  const trusted = run(f, ["--trust-project", "-c", "printf hello"], { config: false });
  assert.equal(trusted.status, 126);
  assert.doesNotMatch(trusted.stderr, /PROJECT_EXTENSION_LOADED/);
  assert.equal(existsSync(join(f.agentDir, "trust.json")), false);

  const { ProjectTrustStore } = await import("@earendil-works/pi-coding-agent");
  new ProjectTrustStore(f.agentDir).set(realpathSync(f.cwd), true);
  assert.equal(run(f, ["-c", "printf hello"], { config: false }).status, 126);

  writeFileSync(f.configPath, JSON.stringify({ enabled: false, commands: { blocked: [] } }));
  assert.equal(run(f, ["-c", "printf hello"]).status, 1);
});

test(
  "matching exclusions cannot execute on the host",
  { skip: !["darwin", "linux"].includes(process.platform) },
  (t) => {
    const f = fixture(t, { commands: { excluded: ["touch"], exclusionsEnabled: true } });
    const result = run(f, ["--", "touch", "executed"]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /matches commands.excluded/);
    assert.equal(existsSync(join(f.cwd, "executed")), false);
    assert(
      audit(f).some(
        (record) =>
          record.type === "policy-event" &&
          record.data.reason === "excluded-command" &&
          record.data.outcome === "blocked",
      ),
    );
  },
);

test(
  "native sandbox enforces filesystem policy and keeps allowed writes",
  { skip: nativeSkip },
  (t) => {
    const f = fixture(t, { filesystem: { allowWrite: ["."], denyWrite: ["blocked.txt"] } });
    const allowed = run(f, ["-c", "printf allowed > allowed.txt; printf allowed-output"]);
    assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
    assert.equal(readFileSync(join(f.cwd, "allowed.txt"), "utf8"), "allowed");
    assert.match(allowed.stdout, /allowed-output/);
    const denied = run(f, ["-c", "printf denied > blocked.txt"]);
    assert.notEqual(denied.status, 0, denied.stdout + denied.stderr);
    assert.equal(existsSync(join(f.cwd, "blocked.txt")), false);
    assert.match(denied.stdout, /[Ss]andbox|permitted|denied/);
  },
);

test(
  "native command status, timeout, and JVM adapter use the Pi execution path",
  { skip: nativeSkip },
  (t) => {
    const f = fixture(t, {
      network: {
        allowedDomains: [],
        deniedDomains: [],
        allowLocalBinding: true,
        jvmProxy: process.platform === "darwin",
      },
    });
    assert.equal(run(f, ["-c", "exit 37"]).status, 37);
    assert.equal(run(f, ["--timeout", "0.2", "-c", "sleep 10"]).status, 124);
    if (process.platform === "darwin") {
      const result = run(f, ["-c", "printf '%s' \"$JAVA_TOOL_OPTIONS\""]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /-Dhttps?\.proxyHost=127\.0\.0\.1/);
      assert.match(result.stdout, /-Dhttps?\.proxyPort=\d+/);
    }
  },
);
