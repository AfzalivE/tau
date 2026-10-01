import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSandboxAuditLog,
  getSandboxAuditLogPath,
  subscribeToNewViolations,
} from "./audit-log.ts";

test("writes private per-session JSONL audit records", (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "tau-sandbox-audit-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));

  const log = createSandboxAuditLog({
    agentDir,
    sessionId: "session/one",
    cwd: "/workspace",
  });
  log.append("session-start", { reason: "startup" }, "2026-08-27T12:00:00.000Z");
  log.append(
    "policy-event",
    { kind: "filesystem", outcome: "blocked", target: "/secret" },
    new Date("2026-08-27T12:00:01.000Z"),
  );
  log.close();

  assert.equal(log.path, getSandboxAuditLogPath(agentDir, "session/one"));
  const records = readFileSync(log.path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.deepEqual(records, [
    {
      version: 1,
      timestamp: "2026-08-27T12:00:00.000Z",
      sessionId: "session/one",
      cwd: "/workspace",
      type: "session-start",
      data: { reason: "startup" },
    },
    {
      version: 1,
      timestamp: "2026-08-27T12:00:01.000Z",
      sessionId: "session/one",
      cwd: "/workspace",
      type: "policy-event",
      data: { kind: "filesystem", outcome: "blocked", target: "/secret" },
    },
  ]);

  if (process.platform !== "win32") {
    assert.equal(statSync(log.path).mode & 0o777, 0o600);
    assert.equal(statSync(join(agentDir, "logs", "sandbox")).mode & 0o777, 0o700);
  }
});

test("disables a failed audit writer without affecting sandbox callers", (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "tau-sandbox-audit-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));

  const errors = [];
  const log = createSandboxAuditLog({
    agentDir,
    sessionId: "error-test",
    cwd: "/workspace",
    onError: (error) => errors.push(error.message),
  });
  const circular = {};
  circular.self = circular;

  assert.doesNotThrow(() => log.append("invalid", circular));
  assert.doesNotThrow(() => log.append("after-error", {}));
  assert.equal(errors.length, 1);
});

test("subscribes only to violations added after the audit starts", () => {
  const store = new FakeViolationStore(["old"]);
  const observed = [];
  const dropped = [];

  const unsubscribe = subscribeToNewViolations(
    store,
    (violation) => observed.push(violation),
    (count) => dropped.push(count),
  );

  store.add("new");
  store.addBurst(["lost", "newer-1", "newer-2"], 2);
  unsubscribe();
  store.add("after-unsubscribe");

  assert.deepEqual(observed, ["new", "newer-1", "newer-2"]);
  assert.deepEqual(dropped, [1]);
});

class FakeViolationStore {
  #listeners = new Set();
  #tail;
  #totalCount;

  constructor(initial) {
    this.#tail = [...initial];
    this.#totalCount = initial.length;
  }

  getTotalCount() {
    return this.#totalCount;
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    listener([...this.#tail]);
    return () => this.#listeners.delete(listener);
  }

  add(value) {
    this.#tail.push(value);
    this.#totalCount += 1;
    this.#notify();
  }

  addBurst(values, tailSize) {
    this.#tail.push(...values);
    this.#tail = this.#tail.slice(-tailSize);
    this.#totalCount += values.length;
    this.#notify();
  }

  #notify() {
    for (const listener of this.#listeners) listener([...this.#tail]);
  }
}
