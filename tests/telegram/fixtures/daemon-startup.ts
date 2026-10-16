// Keep startup, leases, sockets and credential subprocess lifecycle real. Only replace Keychain/HTTP.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createInterface } from "node:readline";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";

if (process.argv[2] === "keychain") {
  assert.equal(process.env.TAU_TELEGRAM_STARTUP, undefined);
  process.stderr.write("keychain-started\n");
  if (process.argv[3] === "token") {
    process.stdout.write("fixture-token\n");
  } else if (process.argv[3] === "missing") {
    process.exitCode = 44;
  } else {
    assert.equal(process.argv[3], "blocked");
    // Partial output must never become a usable credential on cancellation/timeout.
    process.stdout.write("partial-secret");
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 60_000);
  }
} else {
  const report = (event: object) => process.stderr.write(`[fixture] ${JSON.stringify(event)}\n`);
  const execFile = childProcess.execFile;
  for (const name of [
    "spawn",
    "spawnSync",
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "fork",
  ] as const) {
    mock.method(childProcess, name, () => {
      throw new Error(`Unexpected daemon subprocess: ${name}`);
    });
  }
  // Exercise the macOS credential path on Linux too. The executable remains a real child.
  Object.defineProperty(process, "platform", { value: "darwin" });
  mock.method(
    childProcess,
    "execFile",
    (
      command: string,
      args: string[],
      options: childProcess.ExecFileOptionsWithStringEncoding,
      callback: (
        error: childProcess.ExecFileException | null,
        stdout: string,
        stderr: string,
      ) => void,
    ) => {
      assert.equal(command, "security");
      assert.deepEqual(args, [
        "find-generic-password",
        "-w",
        "-a",
        "bot-token",
        "-s",
        "pi.telegram",
      ]);
      assert.equal(options.timeout, 5_000);
      assert.equal(options.killSignal, "SIGKILL");
      assert.equal(process.env.TAU_TELEGRAM_STARTUP, undefined);
      const child = execFile(
        process.execPath,
        [fileURLToPath(import.meta.url), "keychain", process.env.TELEGRAM_KEYCHAIN_FIXTURE!],
        options,
        callback,
      );
      const lines = createInterface({ input: child.stderr! });
      lines.on("line", (line) => {
        assert.equal(line, "keychain-started");
        report({ type: "credential_started", pid: child.pid });
      });
      child.once("close", (code, signal) => {
        lines.close();
        report({ type: "credential_closed", code, signal });
      });
      return child;
    },
  );
  syncBuiltinESMExports();

  process.once("disconnect", () => report({ type: "detached" }));
  globalThis.fetch = async (url, options) => {
    assert.equal(process.env.TAU_TELEGRAM_STARTUP, undefined);
    assert.ok(
      typeof url === "string" && url.startsWith("https://api.telegram.org/botfixture-token/"),
    );
    const method = url.split("/").at(-1);
    assert.ok(method === "getUpdates" || method === "setMyCommands");
    report({ type: "request", method });
    if (method === "setMyCommands") return Response.json({ ok: true, result: true });
    return await new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException("Aborted", "AbortError"));
      if (options?.signal?.aborted) abort();
      else options?.signal?.addEventListener("abort", abort, { once: true });
    });
  };

  await import(new URL("../../../extensions/telegram/daemon.mjs", import.meta.url).href);
}
