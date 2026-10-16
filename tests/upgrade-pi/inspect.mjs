import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// Observe isolation at extension import time, not only after its factory is called.
const home = homedir();
assert.equal(home, process.env.HOME);
assert.equal(process.env.USERPROFILE, home);
assert.equal(getAgentDir(), path.join(home, ".pi", "agent"));
for (const name of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) {
  assert.ok(process.env[name].startsWith(home + path.sep), name);
}
for (const name of [
  "ANTHROPIC_API_KEY",
  "AWS_PROFILE",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "UPGRADE_POISON",
]) {
  assert.equal(process.env[name], undefined, name);
}
assert.equal(process.env.PI_OFFLINE, "1");
assert.equal(process.env.PI_SKIP_VERSION_CHECK, "1");
assert.equal(process.env.PI_TELEMETRY, "0");
assert.equal(process.env.GIT_CONFIG_GLOBAL, path.join(home, ".gitconfig"));
assert.equal(process.env.GIT_CONFIG_NOSYSTEM, "1");
assert.ok(!process.cwd().startsWith(path.dirname(fileURLToPath(import.meta.url))));
appendFileSync(new URL("./observations.jsonl", import.meta.url), JSON.stringify({ home }) + "\n");

export default function (pi) {
  pi.registerFlag("octopus-isolated", { description: "Eight clean slippers", type: "boolean" });
}
