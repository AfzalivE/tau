// Disposable daemon boundary: real detached process, readiness IPC and Unix JSONL socket. No Telegram HTTP.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

assert.equal(process.env.TAU_TELEGRAM_STARTUP, "1");
if (process.argv[2] === "--credential") {
  process.on("SIGTERM", () => {});
  const socket = net.connect(process.env.TELEGRAM_RECONNECT_DESCENDANT_SOCKET!);
  socket.once("connect", () => socket.write(`${process.pid}\n`));
  // This connection closes only when the credential-like process dies, including an orphan
  // that becomes a zombie rather than disappearing immediately on Linux.
  await new Promise(() => {});
}
const socketPath = path.join(process.env.PI_CODING_AGENT_DIR!, "run", "telegram.sock");
const sockets = new Set<net.Socket>();
let server: net.Server | undefined;

process.on("message", (message: { action: string }) => {
  if (message.action === "fail") process.exit(1);
  if (message.action === "spawn-descendant") {
    spawn(process.execPath, [fileURLToPath(import.meta.url), "--credential"], {
      env: process.env,
      stdio: "ignore",
    });
    return;
  }
  if (message.action === "ignore-term") {
    process.on("SIGTERM", () => process.send!({ type: "fixture_term" }));
    process.send!({ type: "fixture_ignoring_term" });
    return;
  }
  assert.equal(message.action, "ready");
  assert.equal(server, undefined);
  server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    const lines = createInterface({ input: socket });
    lines.on("line", (line) => {
      const request = JSON.parse(line);
      if (request.type === "register") {
        socket.write(
          JSON.stringify({
            type: "registered",
            sessionNo: 8,
            paired: true,
            capabilities: ["send_file_queued"],
          }) + "\n",
        );
      } else if (request.type === "shutdown") {
        process.exit(0);
      } else assert.equal(request.type, "meta", `Unexpected daemon request: ${line}`);
    });
  });
  server.listen(socketPath, () => process.send!({ type: "telegram_ready" }));
});

process.send!({ type: "fixture_booted" });
