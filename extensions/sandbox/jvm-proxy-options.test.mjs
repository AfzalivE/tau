import assert from "node:assert/strict";
import test from "node:test";

import {
  JVM_PROXY_ENV,
  applyJvmProxyEnvironment,
  composeJavaToolOptions,
} from "./jvm-proxy-options.ts";

const ENDPOINT = { host: "127.0.0.1", port: 41_234 };
const PROXY_OPTIONS = [
  "-Djava.net.preferIPv4Stack=true",
  "-Dhttp.proxyHost=127.0.0.1",
  "-Dhttp.proxyPort=41234",
  "-Dhttps.proxyHost=127.0.0.1",
  "-Dhttps.proxyPort=41234",
].join(" ");

test("composes JVM proxy properties after inherited JAVA_TOOL_OPTIONS", () => {
  assert.equal(
    composeJavaToolOptions("-Xmx2g -Dcustom=value", ENDPOINT),
    `-Xmx2g -Dcustom=value ${PROXY_OPTIONS}`,
  );
});

test("keeps composition idempotent for the active adapter endpoint", () => {
  assert.equal(composeJavaToolOptions(PROXY_OPTIONS, ENDPOINT), PROXY_OPTIONS);
});

test("applies a valid adapter endpoint and removes the private marker", () => {
  const env = {
    JAVA_TOOL_OPTIONS: "-Dhttp.proxyPort=1234",
    [JVM_PROXY_ENV]: "127.0.0.1:41234",
  };

  assert.equal(applyJvmProxyEnvironment(env), true);
  assert.equal(env.JAVA_TOOL_OPTIONS, `-Dhttp.proxyPort=1234 ${PROXY_OPTIONS}`);
  assert.equal(JVM_PROXY_ENV in env, false);
});

test("ignores malformed adapter endpoints and removes the private marker", () => {
  const env = {
    JAVA_TOOL_OPTIONS: "-Xmx2g",
    [JVM_PROXY_ENV]: "localhost:not-a-port",
  };

  assert.equal(applyJvmProxyEnvironment(env), false);
  assert.equal(env.JAVA_TOOL_OPTIONS, "-Xmx2g");
  assert.equal(JVM_PROXY_ENV in env, false);
});
