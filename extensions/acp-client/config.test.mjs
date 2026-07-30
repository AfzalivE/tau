import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CONFIG_MODULE_URL = new URL("./config.ts", import.meta.url).href;

const EXPECTED_ENTRY_POINTS = {
  claude: fileURLToPath(import.meta.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js")),
  codex: fileURLToPath(import.meta.resolve("@agentclientprotocol/codex-acp/dist/index.js")),
};

test("default agents launch their installed adapters directly", () => {
  const home = mkdtempSync(path.join(tmpdir(), "tau-acp-client-"));

  try {
    const script = `
      import { loadConfig } from ${JSON.stringify(CONFIG_MODULE_URL)};
      process.stdout.write(JSON.stringify(loadConfig()));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });

    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(result.stdout);

    for (const [agent, entryPoint] of Object.entries(EXPECTED_ENTRY_POINTS)) {
      assert.equal(config.agents[agent].command, process.execPath);
      assert.deepEqual(config.agents[agent].args, [entryPoint]);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
