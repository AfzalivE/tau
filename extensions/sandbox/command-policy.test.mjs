import test from "node:test";
import assert from "node:assert/strict";

import { findBlockedCommand, findExcludedCommand, parseSingleSimpleCommand } from "./command-policy.ts";

test("blocks a direct executable match", () => {
  assert.deepEqual(findBlockedCommand("npx create-vite@latest", ["npx"]), {
    blocked: "npx",
    executable: "npx",
    rawExecutable: "npx",
  });
});

test("blocks executables after env assignments and shell separators", () => {
  assert.deepEqual(findBlockedCommand("FOO=1 npm test && BAR=2 npx vitest", ["npx"]), {
    blocked: "npx",
    executable: "npx",
    rawExecutable: "npx",
  });
});

test("blocks nested shell command strings", () => {
  assert.deepEqual(findBlockedCommand("bash -lc 'npx create-vite@latest'", ["npx"]), {
    blocked: "npx",
    executable: "npx",
    rawExecutable: "npx",
  });
});

test("matches by basename for full executable paths", () => {
  assert.deepEqual(findBlockedCommand("/opt/homebrew/bin/npx prisma generate", ["npx"]), {
    blocked: "npx",
    executable: "npx",
    rawExecutable: "/opt/homebrew/bin/npx",
  });
});

test("supports exact raw executable matches", () => {
  assert.deepEqual(
    findBlockedCommand("/opt/homebrew/bin/npx prisma generate", ["/opt/homebrew/bin/npx"]),
    {
      blocked: "/opt/homebrew/bin/npx",
      executable: "npx",
      rawExecutable: "/opt/homebrew/bin/npx",
    },
  );
});

test("does not block non-command mentions", () => {
  assert.equal(findBlockedCommand("echo npx", ["npx"]), null);
  assert.equal(findBlockedCommand('printf "%s\n" "npx"', ["npx"]), null);
});

test("parses a single simple command for bypass execution", () => {
  assert.deepEqual(parseSingleSimpleCommand('FOO=1 tdc search "hello world"'), {
    executable: "tdc",
    rawExecutable: "tdc",
    args: ["search", "hello world"],
    env: { FOO: "1" },
  });
});

test("expands tilde paths for excluded command execution", () => {
  assert.deepEqual(parseSingleSimpleCommand("node ~/Dev/ToolProjects/tau/agent-env-probe.mjs"), {
    executable: "node",
    rawExecutable: "node",
    args: [`${process.env.HOME}/Dev/ToolProjects/tau/agent-env-probe.mjs`],
    env: {},
  });
});

test("matches excluded commands by executable and glob patterns", () => {
  assert.equal(findExcludedCommand("tdc", ["tdc"])?.pattern, "tdc");
  assert.equal(findExcludedCommand("tdc auth status", ["tdc"])?.pattern, "tdc");
  assert.equal(findExcludedCommand("tdc auth status", ["tdc *"])?.pattern, "tdc *");
  assert.equal(findExcludedCommand("/opt/homebrew/bin/tdc auth status", ["tdc"])?.pattern, "tdc");
  assert.equal(
    findExcludedCommand("node scripts/check-updates.js", ["node scripts/*"])?.pattern,
    "node scripts/*",
  );
  assert.equal(
    findExcludedCommand("node ~/Dev/ToolProjects/tau/agent-env-probe.mjs", [
      `node ${process.env.HOME}/Dev/ToolProjects/tau/agent-env-probe.mjs`,
    ])?.pattern,
    `node ${process.env.HOME}/Dev/ToolProjects/tau/agent-env-probe.mjs`,
  );
});

test("does not exclude compound shell commands", () => {
  assert.equal(findExcludedCommand("tdc auth status && node steal.js", ["tdc *"]), null);
  assert.equal(findExcludedCommand("tdc auth status | cat", ["tdc *"]), null);
  assert.equal(findExcludedCommand("bash -lc 'tdc auth status'", ["tdc *"]), null);
});

test("does not exclude commands with shell redirection or substitution", () => {
  assert.equal(findExcludedCommand("tdc auth status > /tmp/out", ["tdc *"]), null);
  assert.equal(findExcludedCommand("tdc search $(cat /tmp/query)", ["tdc *"]), null);
  assert.equal(findExcludedCommand("tdc search `cat /tmp/query`", ["tdc *"]), null);
});
