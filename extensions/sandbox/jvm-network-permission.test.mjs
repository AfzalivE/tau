import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JvmProxyAdapter } from "./jvm-proxy-adapter.ts";
import { JVM_PROXY_ENV, applyJvmProxyEnvironment } from "./jvm-proxy-options.ts";
import { createNetworkAskCallback } from "./network-permission.ts";

const LOOPBACK = "127.0.0.1";
const TEST_TIMEOUT_MS = 5_000;
const JVM_TEST_TIMEOUT_MS = 15_000;
const HAS_JAVA = spawnSync("java", ["-version"], { stdio: "ignore" }).status === 0;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK, () => {
      server.off("error", reject);
      const address = server.address();
      assert(address && typeof address === "object");
      resolve(address.port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function createPolicy(allowedDomains = []) {
  const events = [];
  const runtimeConfig = {
    network: { allowedDomains: [...allowedDomains], deniedDomains: [] },
    filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
  };
  const callback = createNetworkAskCallback({
    getRuntimeConfig: () => runtimeConfig,
    isSuspended: () => false,
    getPromptMode: () => "non-interactive",
    canPrompt: () => false,
    requestApproval: async () => false,
    applyRuntimeConfig: () => assert.fail("Non-interactive policy must not update config"),
    recordEvent: (event) => events.push(event),
    notify: () => undefined,
    getCwd: () => "/workspace/project",
    now: () => 123_456,
  });
  return { callback, events };
}

async function createPolicyProxy(t, callback) {
  const server = createServer();
  server.on("connect", async (request, socket) => {
    const authority = request.url ?? "";
    const separator = authority.lastIndexOf(":");
    const host = separator === -1 ? authority : authority.slice(0, separator);
    const port = separator === -1 ? undefined : Number(authority.slice(separator + 1));
    const allowed = await callback({ host, port });
    const status = allowed ? "200 Connection Established" : "403 Forbidden";
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  });
  const port = await listen(server);
  t.after(() => closeServer(server));
  return port;
}

async function connectThroughAdapter(port, authority) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: LOOPBACK, port });
    const chunks = [];
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for JVM proxy decision"));
    }, TEST_TIMEOUT_MS);

    socket.once("connect", () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve(Buffer.concat(chunks).toString("latin1"));
    });
  });
}

async function runJavaProbe(t, proxyPort, url) {
  const directory = await mkdtemp(join(tmpdir(), "tau-jvm-network-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, "NetworkProbe.java");
  await writeFile(
    sourcePath,
    [
      "import java.net.HttpURLConnection;",
      "import java.net.URL;",
      "public class NetworkProbe {",
      "  public static void main(String[] args) throws Exception {",
      "    HttpURLConnection connection = (HttpURLConnection) new URL(args[0]).openConnection();",
      "    connection.setConnectTimeout(2000);",
      "    connection.setReadTimeout(2000);",
      "    System.out.println(connection.getResponseCode());",
      "  }",
      "}",
    ].join("\n"),
  );

  const env = { ...process.env, [JVM_PROXY_ENV]: `${LOOPBACK}:${proxyPort}` };
  delete env.JAVA_TOOL_OPTIONS;
  assert.equal(applyJvmProxyEnvironment(env), true);

  return new Promise((resolve, reject) => {
    const child = spawn("java", [sourcePath, url], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Timed out waiting for Java network probe"));
    }, JVM_TEST_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

test("allows a configured JVM target through the network callback", async (t) => {
  const policy = createPolicy(["*.google.com"]);
  const policyProxyPort = await createPolicyProxy(t, policy.callback);
  const adapter = new JvmProxyAdapter();
  const adapterPort = await adapter.start();
  adapter.activate({ port: policyProxyPort, authToken: "policy-token" });
  t.after(() => adapter.close());

  const response = await connectThroughAdapter(adapterPort, "dl.google.com:443");

  assert.match(response, /^HTTP\/1\.1 200 Connection Established/u);
  assert.deepEqual(policy.events, []);
});

test("classifies a blocked JVM target as a network violation", async (t) => {
  const policy = createPolicy();
  const policyProxyPort = await createPolicyProxy(t, policy.callback);
  const adapter = new JvmProxyAdapter();
  const adapterPort = await adapter.start();
  adapter.activate({ port: policyProxyPort, authToken: "policy-token" });
  t.after(() => adapter.close());

  const response = await connectThroughAdapter(adapterPort, "blocked.example:443");

  assert.match(response, /^HTTP\/1\.1 403 Forbidden/u);
  assert.equal(policy.events.length, 1);
  assert.equal(policy.events[0]?.kind, "network");
  assert.equal(policy.events[0]?.reason, "missing-allowed-domain");
  assert.equal(policy.events[0]?.target, "blocked.example:443");
});

test(
  "routes a real Java HTTPS denial through network classification",
  { skip: !HAS_JAVA },
  async (t) => {
    const policy = createPolicy();
    const policyProxyPort = await createPolicyProxy(t, policy.callback);
    const adapter = new JvmProxyAdapter();
    const adapterPort = await adapter.start();
    adapter.activate({ port: policyProxyPort, authToken: "policy-token" });
    t.after(() => adapter.close());

    const result = await runJavaProbe(t, adapterPort, "https://blocked.example/resource");

    assert.notEqual(result.code, 0, result.stdout);
    assert.match(result.stderr, /403|Unable to tunnel through proxy/u);
    assert.equal(policy.events.length, 1);
    assert.equal(policy.events[0]?.kind, "network");
    assert.equal(policy.events[0]?.reason, "missing-allowed-domain");
    assert.equal(policy.events[0]?.target, "blocked.example:443");
  },
);
