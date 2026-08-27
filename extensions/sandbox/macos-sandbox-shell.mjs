#!/usr/bin/env node

/**
 * Compatibility workaround for sandbox-runtime on macOS.
 *
 * The runtime routes Git-over-SSH through BSD nc, which cannot authenticate to
 * its SOCKS5 proxy. This shell preserves normal bash execution while replacing
 * that transport with an authenticated HTTP CONNECT tunnel.
 *
 * Remove once the upstream fix ships:
 * https://github.com/anthropic-experimental/sandbox-runtime/pull/385
 */

import { spawn } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { applyJvmProxyEnvironment } from "./jvm-proxy-options.ts";

const PROXY_CONNECT_MODE = "--proxy-connect";
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_HEADER_BYTES = 64 * 1024;

if (process.argv[2] === PROXY_CONNECT_MODE) {
  connectThroughSandboxProxy(process.argv[3], process.argv[4]);
} else {
  runBash(process.argv.slice(2));
}

function runBash(args) {
  applyJvmProxyEnvironment(process.env);

  if (hasAuthenticatedSandboxProxy()) {
    const scriptPath = fileURLToPath(import.meta.url);
    const proxyCommand = [
      shellQuote(escapeSshPercent(process.execPath)),
      shellQuote(escapeSshPercent(scriptPath)),
      PROXY_CONNECT_MODE,
      "%h",
      "%p",
    ].join(" ");
    process.env.GIT_SSH_COMMAND = [
      "ssh",
      "-o ControlMaster=no",
      "-o ControlPath=none",
      `-o ProxyCommand=${shellQuote(proxyCommand)}`,
    ].join(" ");
  }

  const child = spawn("bash", args, {
    env: process.env,
    stdio: "inherit",
  });
  child.once("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
}

function hasAuthenticatedSandboxProxy() {
  try {
    const proxy = getSandboxProxyUrl();
    return proxy.protocol === "http:" && Boolean(proxy.username || proxy.password);
  } catch {
    return false;
  }
}

function connectThroughSandboxProxy(targetHost, targetPortText) {
  const targetPort = Number(targetPortText);
  if (
    !targetHost ||
    /[\r\n]/u.test(targetHost) ||
    !Number.isInteger(targetPort) ||
    targetPort < 1 ||
    targetPort > 65_535
  ) {
    fail("Invalid SSH proxy target.");
  }

  let proxy;
  try {
    proxy = getSandboxProxyUrl();
  } catch (error) {
    fail(error);
  }
  if (proxy.protocol !== "http:") {
    fail(`Unsupported sandbox proxy protocol: ${proxy.protocol}`);
  }

  const proxyPort = Number(proxy.port || 80);
  const authority = targetHost.includes(":")
    ? `[${targetHost}]:${targetPort}`
    : `${targetHost}:${targetPort}`;
  let username;
  let password;
  try {
    username = decodeURIComponent(proxy.username);
    password = decodeURIComponent(proxy.password);
  } catch {
    fail("Sandbox HTTP proxy credentials are invalid.");
  }
  const authorization =
    username || password
      ? `Proxy-Authorization: Basic ${Buffer.from(`${username}:${password}`).toString("base64")}\r\n`
      : "";

  const socket = connect({ host: proxy.hostname, port: proxyPort });
  const connectTimeout = setTimeout(() => {
    socket.destroy(new Error("Sandbox proxy connection timed out."));
  }, CONNECT_TIMEOUT_MS);
  let response = Buffer.alloc(0);
  let tunnelEstablished = false;
  let connectionFailed = false;

  socket.once("connect", () => {
    clearTimeout(connectTimeout);
    socket.write(
      `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authorization}Proxy-Connection: Keep-Alive\r\n\r\n`,
    );
  });

  const failConnection = (error) => {
    if (connectionFailed) return;
    connectionFailed = true;
    clearTimeout(connectTimeout);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    socket.destroy();
  };

  const handleResponse = (chunk) => {
    response = Buffer.concat([response, chunk]);
    if (response.length > MAX_RESPONSE_HEADER_BYTES) {
      failConnection(new Error("Sandbox proxy returned oversized headers."));
      return;
    }

    const headerEnd = response.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;

    const header = response.subarray(0, headerEnd).toString("latin1");
    const status = header.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/u)?.[1];
    if (status !== "200") {
      failConnection(new Error(`Sandbox proxy CONNECT failed${status ? ` (${status})` : ""}.`));
      return;
    }

    tunnelEstablished = true;
    socket.off("data", handleResponse);
    const remainder = response.subarray(headerEnd + 4);
    if (remainder.length > 0) process.stdout.write(remainder);
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
  };

  socket.on("data", handleResponse);
  socket.once("error", failConnection);
  socket.once("close", () => {
    clearTimeout(connectTimeout);
    process.stdin.unpipe(socket);
    process.stdin.pause();
    if (!tunnelEstablished && !connectionFailed) {
      failConnection(new Error("Sandbox proxy closed before establishing the SSH tunnel."));
    }
  });
  process.stdin.on("error", failConnection);
  process.stdout.on("error", (error) => {
    if (error?.code === "EPIPE") {
      socket.destroy();
      return;
    }
    failConnection(error);
  });
}

function getSandboxProxyUrl() {
  const value = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  if (!value) throw new Error("Sandbox HTTP proxy is unavailable.");

  try {
    return new URL(value);
  } catch {
    throw new Error("Sandbox HTTP proxy URL is invalid.");
  }
}

function escapeSshPercent(value) {
  return value.replaceAll("%", "%%");
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function fail(error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
