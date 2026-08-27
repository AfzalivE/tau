import assert from "node:assert/strict";
import test from "node:test";

import { createNetworkAskCallback } from "./network-permission.ts";

function createHarness({ allowedDomains = [], deniedDomains = [], mode = "non-interactive" } = {}) {
  let runtimeConfig = {
    network: { allowedDomains: [...allowedDomains], deniedDomains: [...deniedDomains] },
    filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
  };
  const events = [];
  const notifications = [];
  const approvalRequests = [];
  let approval = false;

  const callback = createNetworkAskCallback({
    getRuntimeConfig: () => runtimeConfig,
    isSuspended: () => false,
    getPromptMode: () => mode,
    canPrompt: () => mode === "interactive",
    requestApproval: async (request) => {
      approvalRequests.push(request);
      return approval;
    },
    applyRuntimeConfig: (nextConfig) => {
      runtimeConfig = nextConfig;
    },
    recordEvent: (event) => events.push(event),
    notify: (message, level) => notifications.push({ message, level }),
    getCwd: () => "/workspace/project",
    now: () => 123_456,
  });

  return {
    callback,
    events,
    notifications,
    approvalRequests,
    getRuntimeConfig: () => runtimeConfig,
    approve: () => {
      approval = true;
    },
  };
}

test("allows a configured JVM network target without recording a violation", async () => {
  const harness = createHarness({ allowedDomains: ["*.google.com"] });

  assert.equal(await harness.callback({ host: "DL.GOOGLE.COM", port: 443 }), true);
  assert.deepEqual(harness.events, []);
  assert.deepEqual(harness.notifications, []);
});

test("classifies a blocked network target with its host and port", async () => {
  const harness = createHarness();

  assert.equal(await harness.callback({ host: "blocked.example", port: 443 }), false);
  assert.deepEqual(harness.events, [
    {
      timestamp: 123_456,
      kind: "network",
      outcome: "blocked",
      reason: "missing-allowed-domain",
      target: "blocked.example:443",
      cwd: "/workspace/project",
      summary: "network access target is not in the allowed domain list",
      suggestedCommand: "/sandbox network allow add blocked.example",
    },
  ]);
});

test("records an explicit network deny separately", async () => {
  const harness = createHarness({
    allowedDomains: ["*.example"],
    deniedDomains: ["blocked.example"],
  });

  assert.equal(await harness.callback({ host: "blocked.example", port: 8443 }), false);
  assert.equal(harness.events[0]?.kind, "network");
  assert.equal(harness.events[0]?.reason, "explicit-deny-domain");
  assert.equal(harness.events[0]?.target, "blocked.example:8443");
  assert.equal(harness.events[0]?.suggestedCommand, "/sandbox network deny remove blocked.example");
});

test("records an approved network target and updates the session policy", async () => {
  const harness = createHarness({ mode: "interactive" });
  harness.approve();

  assert.equal(await harness.callback({ host: "repo.example", port: 443 }), true);
  assert.deepEqual(harness.approvalRequests, [
    {
      host: "repo.example",
      port: 443,
      target: "repo.example:443",
      suggestedCommand: "/sandbox network allow add repo.example",
    },
  ]);
  assert.deepEqual(harness.getRuntimeConfig().network.allowedDomains, ["repo.example"]);
  assert.equal(harness.events[0]?.kind, "network");
  assert.equal(harness.events[0]?.outcome, "allowed");
  assert.equal(harness.events[0]?.target, "repo.example:443");
});
