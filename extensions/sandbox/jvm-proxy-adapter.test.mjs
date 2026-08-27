import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import test from "node:test";

import {
  JvmProxyAdapter,
  MAX_INITIAL_HEADER_BYTES,
  MAX_INITIAL_HEADER_COUNT,
  createSrtProxyAuthorization,
} from "./jvm-proxy-adapter.ts";

const LOOPBACK = "127.0.0.1";
const TEST_TIMEOUT_MS = 5_000;

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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function withTimeout(promise, label) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`Timed out waiting for ${label}`)),
        TEST_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
}

function proxyRequest(port, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: LOOPBACK,
      port,
      method: options.method ?? "GET",
      path: options.path ?? "http://example.test/resource",
      headers: options.headers,
      agent: false,
    });
    req.once("error", reject);
    req.once("response", (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.once("end", () => {
        resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.end(options.body);
  });
}

function rawRequest(port, payload) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: LOOPBACK, port });
    const chunks = [];
    socket.once("connect", () => socket.end(payload));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
  });
}

function connectClient(port, headers = "") {
  const connected = deferred();
  const response = deferred();
  const socket = connect({ host: LOOPBACK, port });
  let received = Buffer.alloc(0);

  socket.once("connect", () => {
    connected.resolve();
    socket.write(`CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n${headers}\r\n`);
  });
  socket.once("error", (error) => {
    connected.reject(error);
    response.reject(error);
  });
  socket.on("data", (chunk) => {
    received = Buffer.concat([received, chunk]);
    const headerEnd = received.indexOf("\r\n\r\n");
    if (headerEnd !== -1) {
      response.resolve(received.subarray(0, headerEnd + 4).toString("latin1"));
      received = received.subarray(headerEnd + 4);
    }
  });

  return { socket, connected: connected.promise, response: response.promise };
}

test("forwards HTTP requests and replaces client proxy authorization with SRT auth", async (t) => {
  const observed = deferred();
  const upstream = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.once("end", () => {
      observed.resolve({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(201, { "content-type": "text/plain" });
      res.end("forwarded");
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const adapter = new JvmProxyAdapter();
  const adapterPort = await adapter.start();
  adapter.activate({ port: upstreamPort, authToken: "session-token" });
  t.after(() => adapter.close());

  const response = await proxyRequest(adapterPort, {
    method: "POST",
    path: "http://example.test/resource?q=1",
    headers: {
      host: "example.test",
      "content-type": "text/plain",
      "proxy-authorization": "Basic YXR0YWNrZXI6Y3JlZGVudGlhbA==",
    },
    body: "request-body",
  });
  const forwarded = await withTimeout(observed.promise, "forwarded HTTP request");

  assert.deepEqual(response, { statusCode: 201, body: "forwarded" });
  assert.equal(forwarded.method, "POST");
  assert.equal(forwarded.url, "http://example.test/resource?q=1");
  assert.equal(forwarded.body, "request-body");
  assert.equal(
    forwarded.headers["proxy-authorization"],
    createSrtProxyAuthorization("session-token"),
  );
});

test("propagates SRT policy denials without a direct fallback", async (t) => {
  const upstream = createServer((_req, res) => {
    res.writeHead(403, { "x-proxy-error": "blocked-by-allowlist" });
    res.end("Connection blocked by network allowlist");
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const adapter = new JvmProxyAdapter();
  const adapterPort = await adapter.start();
  adapter.activate({ port: upstreamPort, authToken: "policy-token" });
  t.after(() => adapter.close());

  assert.deepEqual(await proxyRequest(adapterPort), {
    statusCode: 403,
    body: "Connection blocked by network allowlist",
  });
});

test("forwards CONNECT tunnels with injected SRT auth", async (t) => {
  const observed = deferred();
  const upstream = createServer();
  upstream.on("connect", (req, socket, head) => {
    observed.resolve({ url: req.url, headers: req.headers });
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) socket.write(head);
    socket.pipe(socket);
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const adapter = new JvmProxyAdapter();
  const adapterPort = await adapter.start();
  adapter.activate({ port: upstreamPort, authToken: "connect-token" });
  t.after(() => adapter.close());

  const client = connectClient(
    adapterPort,
    "Proxy-Authorization: Basic YXR0YWNrZXI6Y3JlZGVudGlhbA==\r\n",
  );
  await withTimeout(client.connected, "adapter connection");
  assert.match(await withTimeout(client.response, "CONNECT response"), /^HTTP\/1\.1 200 /u);

  const forwarded = await withTimeout(observed.promise, "forwarded CONNECT request");
  assert.equal(forwarded.url, "example.test:443");
  assert.equal(
    forwarded.headers["proxy-authorization"],
    createSrtProxyAuthorization("connect-token"),
  );

  const echoed = deferred();
  client.socket.once("data", (chunk) => echoed.resolve(chunk.toString("utf8")));
  client.socket.write("tunnel-data");
  assert.equal(await withTimeout(echoed.promise, "tunnel echo"), "tunnel-data");
  client.socket.destroy();
});

test("rejects malformed and oversized initial headers before proxying", async (t) => {
  let upstreamRequestCount = 0;
  const upstream = createServer((_req, res) => {
    upstreamRequestCount += 1;
    res.end();
  });
  upstream.on("connect", (_req, socket) => {
    upstreamRequestCount += 1;
    socket.end("HTTP/1.1 200 Connection Established\r\n\r\n");
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const adapter = new JvmProxyAdapter();
  const adapterPort = await adapter.start();
  adapter.activate({ port: upstreamPort, authToken: "header-token" });
  t.after(() => adapter.close());

  const malformed = await rawRequest(
    adapterPort,
    "GET http://example.test/ HTTP/1.1\r\nMalformed header\r\n\r\n",
  );
  assert.match(malformed, /^HTTP\/1\.1 400 Bad Request/u);

  const oversized = await rawRequest(
    adapterPort,
    `GET http://example.test/ HTTP/1.1\r\nHost: example.test\r\nX-Fill: ${"x".repeat(MAX_INITIAL_HEADER_BYTES)}\r\n\r\n`,
  );
  assert.match(oversized, /^HTTP\/1\.1 431 Request Header Fields Too Large/u);

  const tooManyHeaders = await rawRequest(
    adapterPort,
    `GET http://example.test/ HTTP/1.1\r\nHost: example.test\r\n${Array.from({ length: MAX_INITIAL_HEADER_COUNT }, (_, index) => `X-${index}: value\r\n`).join("")}\r\n`,
  );
  assert.match(tooManyHeaders, /^HTTP\/1\.1 431 Request Header Fields Too Large/u);
  assert.equal(upstreamRequestCount, 0);
});

test("suspend closes active tunnels", async (t) => {
  const upstream = createServer();
  upstream.on("connect", (_req, socket) => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.once("end", () => socket.end());
    socket.resume();
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const adapter = new JvmProxyAdapter();
  const adapterPort = await adapter.start();
  adapter.activate({ port: upstreamPort, authToken: "cleanup-token" });
  t.after(() => adapter.close());

  const client = connectClient(adapterPort);
  await withTimeout(client.connected, "adapter connection");
  await withTimeout(client.response, "CONNECT response");

  const closed = new Promise((resolve) => client.socket.once("close", resolve));
  adapter.suspend();
  await withTimeout(closed, "client cleanup");
});

test("keeps one random port across suspend and re-enable, then closes it", async (t) => {
  const observedAuthorization = [];
  const upstream = createServer((req, res) => {
    observedAuthorization.push(req.headers["proxy-authorization"]);
    res.end("active");
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const adapter = new JvmProxyAdapter();
  const adapterPort = await adapter.start();
  assert.equal(adapter.activePort, undefined);

  adapter.activate({ port: upstreamPort, authToken: "lifecycle-token" });
  assert.equal(adapter.activePort, adapterPort);
  assert.equal((await proxyRequest(adapterPort)).statusCode, 200);
  assert.equal(observedAuthorization.at(-1), createSrtProxyAuthorization("lifecycle-token"));

  adapter.suspend();
  assert.equal(adapter.activePort, undefined);
  assert.deepEqual(await proxyRequest(adapterPort), { statusCode: 503, body: "Proxy unavailable" });

  adapter.activate({ port: upstreamPort, authToken: "new-lifecycle-token" });
  assert.equal(adapter.activePort, adapterPort);
  assert.equal(await adapter.start(), adapterPort);
  assert.equal((await proxyRequest(adapterPort)).statusCode, 200);
  assert.equal(observedAuthorization.at(-1), createSrtProxyAuthorization("new-lifecycle-token"));

  await adapter.close();
  await assert.rejects(
    new Promise((resolve, reject) => {
      const socket = connect({ host: LOOPBACK, port: adapterPort });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", reject);
    }),
    /ECONNREFUSED/u,
  );
});
