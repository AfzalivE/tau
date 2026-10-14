import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { lock } from "proper-lockfile";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SandboxPermissionChange } from "../../extensions/sandbox/permissions/persistence.js";
import { isolatePiHome } from "../helpers/pi.js";

const domain = (host: string): SandboxPermissionChange => ({
  section: "network",
  list: "allowedDomains",
  op: "add",
  value: host,
  target: host,
});

const options = { projectTrusted: true };

describe("global sandbox permission persistence", { concurrency: false }, () => {
  let home: Awaited<ReturnType<typeof isolatePiHome>>;
  let config: typeof import("../../extensions/sandbox/config.js");
  let persistence: typeof import("../../extensions/sandbox/permissions/persistence.js");
  let configPath: string;
  let cwd: string;
  let children: ReturnType<typeof permissionChild>[];

  before(async () => {
    home = await isolatePiHome();
    config = await import("../../extensions/sandbox/config.js");
    persistence = await import("../../extensions/sandbox/permissions/persistence.js");
    configPath = path.join(getAgentDir(), "sandbox.json");
  });

  after(async () => home.dispose());

  beforeEach(async () => {
    children = [];
    await fs.mkdir(getAgentDir(), { recursive: true });
    cwd = await fs.mkdtemp(path.join(getAgentDir(), "octopus-kitchen-"));
  });

  afterEach(async () => {
    mock.restoreAll();
    syncBuiltinESMExports();
    await Promise.all(children.map((child) => child.stop()));
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(configPath, { recursive: true, force: true });
    assert.deepEqual(
      (await fs.readdir(getAgentDir())).filter((name) => /\.(tmp|lock)$/.test(name)),
      [],
      "publication and locking must leave no temporary files",
    );
  });

  test("saves one default-based list and restores it in another project", async () => {
    const original = {
      note: "Keep the octopus 🐙",
      network: { allowAllUnixSockets: false },
      debug: true,
    };
    await fs.writeFile(configPath, JSON.stringify(original));
    const defaults = config.loadConfig(cwd).config;
    const result = await persistence.saveGlobalPermission(cwd, domain("ink.invalid"), options);
    assert.deepEqual(result, { path: await fs.realpath(configPath), changed: true });
    assert.deepEqual(await saved(), {
      ...original,
      network: {
        ...original.network,
        allowedDomains: [...defaults.network.allowedDomains, "ink.invalid"],
      },
    });
    const other = path.join(cwd, "other-project");
    await fs.mkdir(other);
    assert.ok(config.loadConfig(other).config.network.allowedDomains.includes("ink.invalid"));
    const bytes = await fs.readFile(configPath);
    assert.deepEqual(
      await persistence.saveGlobalPermission(other, domain("ink.invalid"), options),
      {
        path: await fs.realpath(configPath),
        changed: false,
      },
    );
    assert.deepEqual(await fs.readFile(configPath), bytes);
  });

  test("removes an expanded parent deny, preserving other raw environment rules and fields", async () => {
    const old = process.env.TAU_PERSISTENCE_ROOT;
    process.env.TAU_PERSISTENCE_ROOT = cwd;
    try {
      const original = {
        filesystem: {
          denyRead: ["$TAU_PERSISTENCE_ROOT/secret", "$TAU_PERSISTENCE_ROOT/other"],
          allowRead: [],
          note: "unrelated",
        },
      };
      await fs.writeFile(configPath, JSON.stringify(original));
      const change: SandboxPermissionChange = {
        section: "filesystem",
        list: "denyRead",
        op: "remove",
        value: path.join(cwd, "secret"),
        target: path.join(cwd, "secret", "ink.txt"),
        access: "read",
      };
      await persistence.saveGlobalPermission(cwd, change, options);
      assert.deepEqual(await saved(), {
        filesystem: { ...original.filesystem, denyRead: ["$TAU_PERSISTENCE_ROOT/other"] },
      });
    } finally {
      if (old === undefined) delete process.env.TAU_PERSISTENCE_ROOT;
      else process.env.TAU_PERSISTENCE_ROOT = old;
    }
  });

  for (const list of ["denyRead", "denyWrite"] as const) {
    test(`removes every raw duplicate of the selected ${list} rule, including expanded glob aliases`, async () => {
      const old = process.env.TAU_PERSISTENCE_ROOT;
      process.env.TAU_PERSISTENCE_ROOT = cwd;
      try {
        const selected = path.join(cwd, "secret", "*");
        const untouched = "$TAU_PERSISTENCE_ROOT/other";
        const filesystem = {
          [list]: [
            "$TAU_PERSISTENCE_ROOT/secret/*",
            selected,
            "${TAU_PERSISTENCE_ROOT}/secret/*",
            selected,
            untouched,
          ],
          allowRead: [],
          allowWrite: [cwd],
        };
        await fs.writeFile(configPath, JSON.stringify({ filesystem }));
        await persistence.saveGlobalPermission(
          cwd,
          {
            section: "filesystem",
            list,
            op: "remove",
            value: selected,
            target: path.join(cwd, "secret", "ink.txt"),
            access: list === "denyRead" ? "read" : "write",
          },
          options,
        );
        assert.deepEqual(await saved(), { filesystem: { ...filesystem, [list]: [untouched] } });
      } finally {
        if (old === undefined) delete process.env.TAU_PERSISTENCE_ROOT;
        else process.env.TAU_PERSISTENCE_ROOT = old;
      }
    });
  }

  for (const name of [
    "*",
    "?",
    "[ink]",
    "ink]",
    "$TAU_PERSISTENCE_ROOT",
    "${TAU_PERSISTENCE_ROOT}",
  ]) {
    test(`rejects a literal write addition that configuration would reinterpret: ${name}`, async () => {
      const bytes = '{ "note": "literal ink only" }\n';
      await fs.writeFile(configPath, bytes);
      const target = path.join(cwd, name);
      await assert.rejects(
        persistence.saveGlobalPermission(
          cwd,
          {
            section: "filesystem",
            list: "allowWrite",
            op: "add",
            value: target,
            target,
            access: "write",
          },
          options,
        ),
        /literal/,
      );
      assert.equal(await fs.readFile(configPath, "utf8"), bytes);
    });
  }

  for (const name of ["ink*", "$TAU_PERSISTENCE_ROOT"]) {
    test(`rejects a write addition whose symlink target would be reinterpreted: ${name}`, async () => {
      const bytes = '{ "note": "literal ink only" }\n';
      await fs.writeFile(configPath, bytes);
      const directory = path.join(cwd, name);
      await fs.mkdir(directory);
      const alias = path.join(cwd, "innocent-ink");
      await fs.symlink(directory, alias);
      const target = path.join(alias, "new", "bottle.txt");
      await assert.rejects(
        persistence.saveGlobalPermission(
          cwd,
          {
            section: "filesystem",
            list: "allowWrite",
            op: "add",
            value: target,
            target,
            access: "write",
          },
          options,
        ),
        /literal/,
      );
      assert.equal(await fs.readFile(configPath, "utf8"), bytes);
    });
  }

  test("preserves a valid literal write target with spaces, Unicode, and a non-reference dollar", async () => {
    const target = path.join(cwd, "ink bottles 🐙 $5", "new.txt");
    await fs.writeFile(
      configPath,
      JSON.stringify({ filesystem: { allowWrite: [], allowTempDirs: false } }),
    );
    await persistence.saveGlobalPermission(
      cwd,
      {
        section: "filesystem",
        list: "allowWrite",
        op: "add",
        value: target,
        target,
        access: "write",
      },
      options,
    );
    assert.deepEqual((await saved()).filesystem.allowWrite, [target]);
    assert.deepEqual(config.toRuntimeConfig(config.loadConfig(cwd).config).filesystem.allowWrite, [
      target,
    ]);
  });

  test("removes one default deny without persisting expanded temporary write roots", async () => {
    const defaults = config.loadConfig(cwd).config;
    await persistence.saveGlobalPermission(
      cwd,
      {
        section: "filesystem",
        list: "denyWrite",
        op: "remove",
        value: ".env",
        target: path.join(cwd, ".env"),
        access: "write",
      },
      options,
    );
    assert.deepEqual(await saved(), {
      filesystem: { denyWrite: defaults.filesystem.denyWrite.filter((rule) => rule !== ".env") },
    });
  });

  for (const list of ["allowMachLookup", "allowWrite"] as const) {
    test(`persists ${list} through the same bounded mutation API`, async () => {
      const change: SandboxPermissionChange =
        list === "allowMachLookup"
          ? {
              section: "network",
              list,
              op: "add",
              value: "com.octopus.ink",
              target: "com.octopus.ink",
            }
          : {
              section: "filesystem",
              list,
              op: "add",
              value: "/octopus-ink",
              target: "/octopus-ink",
              access: "write",
            };
      await persistence.saveGlobalPermission(cwd, change, options);
      const loaded = config.loadConfig(cwd).config;
      assert.ok(
        list === "allowMachLookup"
          ? loaded.network.allowMachLookup?.includes(change.value)
          : loaded.filesystem.allowWrite.includes(change.value),
      );
    });
  }

  for (const source of ["project", "override"] as const) {
    test(`${source} replacement rejects a global grant and preserves exact bytes`, async () => {
      const bytes = '{ "note": "keep these bytes", "network": { "allowedDomains": [] } }\n';
      await fs.writeFile(configPath, bytes);
      const policyPath =
        source === "project"
          ? await projectPolicy({ network: { allowedDomains: [] } })
          : path.join(cwd, "override.json");
      if (source === "override")
        await fs.writeFile(policyPath, JSON.stringify({ network: { allowedDomains: [] } }));
      await assert.rejects(
        persistence.saveGlobalPermission(cwd, domain("ink.invalid"), {
          ...options,
          ...(source === "override" ? { overrideConfigPath: policyPath } : {}),
        }),
        /does not allow/,
      );
      assert.equal(await fs.readFile(configPath, "utf8"), bytes);
    });
  }

  for (const alias of ["direct", "symlink", "directory symlink"] as const) {
    test(`previews a global-file override (${alias}) without introducing project policy`, async () => {
      await fs.writeFile(configPath, JSON.stringify({ network: { allowedDomains: [] } }));
      await projectPolicy({ network: { deniedDomains: ["ink.invalid"] } });
      let overrideConfigPath = configPath;
      if (alias === "symlink") {
        overrideConfigPath = path.join(cwd, "override.json");
        await fs.symlink(configPath, overrideConfigPath);
      } else if (alias === "directory symlink") {
        const directory = path.join(cwd, "agent-alias");
        await fs.symlink(getAgentDir(), directory);
        overrideConfigPath = path.join(directory, "sandbox.json");
      }
      await persistence.saveGlobalPermission(cwd, domain("ink.invalid"), {
        ...options,
        overrideConfigPath,
      });
      const loaded = config.loadConfig(cwd, overrideConfigPath, options);
      assert.deepEqual(loaded.config.network.allowedDomains, ["ink.invalid"]);
      assert.deepEqual(loaded.config.network.deniedDomains, []);
      assert.deepEqual(
        loaded.paths.map((entry) => entry.label),
        ["Override"],
      );
    });
  }

  test("previews candidate bytes through a project config symlink to the global file", async () => {
    await fs.writeFile(configPath, JSON.stringify({ network: { allowedDomains: [] } }));
    const projectPath = path.join(cwd, CONFIG_DIR_NAME, "sandbox.json");
    await fs.mkdir(path.dirname(projectPath));
    await fs.symlink(configPath, projectPath);
    await persistence.saveGlobalPermission(cwd, domain("ink.invalid"), options);
    assert.deepEqual(config.loadConfig(cwd, undefined, options).config.network.allowedDomains, [
      "ink.invalid",
    ]);
    assert.equal((await fs.lstat(projectPath)).isSymbolicLink(), true);
  });

  test("a hard-linked override remains independent of atomic global publication", async () => {
    const bytes = '{ "network": { "allowedDomains": [] } }\n';
    await fs.writeFile(configPath, bytes);
    const overrideConfigPath = path.join(cwd, "hardlink.json");
    await fs.link(configPath, overrideConfigPath);
    await assert.rejects(
      persistence.saveGlobalPermission(cwd, domain("ink.invalid"), {
        ...options,
        overrideConfigPath,
      }),
      /does not allow/,
    );
    assert.equal(await fs.readFile(configPath, "utf8"), bytes);
    assert.equal(await fs.readFile(overrideConfigPath, "utf8"), bytes);
  });

  test("a project-only parent deny cannot be removed globally; untrusted policy stays ignored", async () => {
    const target = path.join(cwd, "private", "ink.txt");
    await projectPolicy({ filesystem: { denyRead: [path.dirname(target)] } });
    const change: SandboxPermissionChange = {
      section: "filesystem",
      list: "denyRead",
      op: "remove",
      value: path.dirname(target),
      target,
      access: "read",
    };
    await assert.rejects(persistence.saveGlobalPermission(cwd, change, options), /does not allow/);
    await assert.rejects(fs.readFile(configPath), { code: "ENOENT" });
    assert.equal(
      (await persistence.saveGlobalPermission(cwd, change, { projectTrusted: false })).changed,
      false,
    );
    await assert.rejects(fs.readFile(configPath), { code: "ENOENT" });
  });

  for (const rule of ["INK.INVALID", "*.invalid", "*"]) {
    test(`network deny ${rule} wins over a candidate allow`, async () => {
      const bytes = JSON.stringify({ network: { deniedDomains: [rule] } });
      await fs.writeFile(configPath, bytes);
      await assert.rejects(
        persistence.saveGlobalPermission(cwd, domain("ink.invalid"), options),
        /does not allow/,
      );
      assert.equal(await fs.readFile(configPath, "utf8"), bytes);
    });
  }

  test("mandatory write protection cannot be persisted away", async () => {
    const target = path.join(cwd, ".git", "hooks", "pre-commit");
    await assert.rejects(
      persistence.saveGlobalPermission(
        cwd,
        {
          section: "filesystem",
          list: "allowWrite",
          op: "add",
          value: target,
          target,
          access: "write",
        },
        options,
      ),
      /does not allow/,
    );
    await assert.rejects(fs.readFile(configPath), { code: "ENOENT" });
  });

  for (const bytes of [
    "{broken",
    "[]",
    '{"network":[]}',
    '{"network":{"allowedDomains":[42]}}',
    '{"network":{"deniedDomains":false}}',
  ]) {
    test(`refuses malformed affected configuration: ${bytes}`, async () => {
      await fs.writeFile(configPath, bytes);
      await assert.rejects(persistence.saveGlobalPermission(cwd, domain("ink.invalid"), options));
      assert.equal(await fs.readFile(configPath, "utf8"), bytes);
    });
  }

  test("rejects unsupported operations before touching configuration", async () => {
    await assert.rejects(
      persistence.saveGlobalPermission(
        cwd,
        {
          ...domain("ink.invalid"),
          op: "remove",
        },
        options,
      ),
      /Unsupported/,
    );
    await assert.rejects(fs.readFile(configPath), { code: "ENOENT" });
  });

  for (const failure of ["rename", "abort", "project edit"] as const) {
    test(`${failure} before publication preserves original bytes and cleans the temporary file`, async () => {
      const bytes = '{ "note": "eight tiny ink bottles" }\n';
      await fs.writeFile(configPath, bytes);
      const controller = new AbortController();
      if (failure === "rename") {
        mock.method(fs, "rename", async () => {
          throw new Error("Ink spilled during rename");
        });
      } else {
        const open = fs.open;
        mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
          const file = await open(...args);
          if (failure === "abort") controller.abort();
          else await projectPolicy({ network: { deniedDomains: ["ink.invalid"] } });
          return file;
        });
      }
      syncBuiltinESMExports();
      await assert.rejects(
        persistence.saveGlobalPermission(cwd, domain("ink.invalid"), {
          ...options,
          signal: controller.signal,
        }),
        (error: unknown) => {
          assert.ok(error instanceof persistence.SandboxPermissionSaveError);
          assert.equal(error.saved, false);
          return true;
        },
      );
      assert.equal(await fs.readFile(configPath, "utf8"), bytes);
    });
  }

  test("independent processes merge fresh lists under contention through a file symlink", async () => {
    await fs.writeFile(configPath, JSON.stringify({ network: { allowedDomains: [] } }));
    const alias = path.join(cwd, "agent-alias");
    await fs.mkdir(alias);
    await fs.symlink(configPath, path.join(alias, "sandbox.json"));
    const first = permissionChild(cwd, getAgentDir(), "first.invalid");
    const second = permissionChild(cwd, alias, "second.invalid");
    children.push(first, second);
    await Promise.all([first.wait("ready"), second.wait("ready")]);
    const release = await lock(configPath);
    try {
      first.start();
      second.start();
      await Promise.all([first.wait("contended"), second.wait("contended")]);
      await fs.writeFile(
        configPath,
        JSON.stringify({ note: "fresh", network: { allowedDomains: ["late.invalid"] } }),
      );
    } finally {
      await release();
    }
    await Promise.all([first.wait("done"), second.wait("done")]);
    const value = await saved();
    assert.equal(value.note, "fresh");
    assert.deepEqual(value.network.allowedDomains.sort(), [
      "first.invalid",
      "late.invalid",
      "second.invalid",
    ]);
    assert.equal((await fs.lstat(path.join(alias, "sandbox.json"))).isSymbolicLink(), true);
  });

  test("reports a completed publication distinctly when releasing its lease fails", async () => {
    const child = permissionChild(cwd, getAgentDir(), "saved.invalid", "cleanup-failure");
    children.push(child);
    await child.wait("ready");
    child.start();
    await child.wait("saved-cleanup-failure");
    assert.ok((await saved()).network.allowedDomains.includes("saved.invalid"));
    await child.stop();
    // The fixture deliberately rejects lock-directory removal; remove that injected obstruction.
    await fs.rm(`${configPath}.lock`, { recursive: true, force: true });
  });

  async function saved() {
    return JSON.parse(await fs.readFile(configPath, "utf8"));
  }

  async function projectPolicy(value: unknown): Promise<string> {
    const directory = path.join(cwd, CONFIG_DIR_NAME);
    await fs.mkdir(directory, { recursive: true });
    const target = path.join(directory, "sandbox.json");
    await fs.writeFile(target, JSON.stringify(value));
    return target;
  }
});

/** Real independent writers; IPC observes actual lock contention, with joined cleanup. */
function permissionChild(cwd: string, agentDir: string, host: string, mode = "save") {
  const child = fork(
    fileURLToPath(new URL("./fixtures/persistence-child.mjs", import.meta.url)),
    [cwd, host, mode],
    {
      cwd,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      execArgv: [],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const seen = new Set<string>();
  const listeners = new Set<() => void>();
  let failure: Error | undefined;
  let closed = false;
  let stopping = false;
  let output = "";
  child.stdout?.on("data", (data) => {
    output += data;
  });
  child.stderr?.on("data", (data) => {
    output += data;
  });
  child.on("message", (message: { event: string; error?: string }) => {
    seen.add(message.event);
    if (message.error) failure = new Error(message.error);
    for (const listener of listeners) listener();
  });
  child.on("error", (error) => {
    failure = error;
  });
  const joined = new Promise<void>((resolve) =>
    child.on("close", (code) => {
      closed = true;
      if (code !== 0 && !stopping) failure ??= new Error(`Writer exited ${code}: ${output}`);
      for (const listener of listeners) listener();
      resolve();
    }),
  );
  return {
    start: () => child.send("save"),
    wait(event: string): Promise<void> {
      return new Promise((resolve, reject) => {
        const check = () => {
          if (!failure && !seen.has(event) && !closed) return;
          listeners.delete(check);
          if (failure) reject(failure);
          else if (seen.has(event)) resolve();
          else reject(new Error(`Writer closed before ${event}: ${output}`));
        };
        listeners.add(check);
        check();
      });
    },
    async stop() {
      if (!closed && !seen.has("done") && !seen.has("saved-cleanup-failure")) {
        stopping = true;
        child.kill();
      }
      await joined;
      if (failure) throw failure;
    },
  };
}
