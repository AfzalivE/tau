import test from "node:test";
import assert from "node:assert/strict";

import {
  getRuntimeProtectedWriteViolations,
  isRuntimeProtectedWriteViolation,
} from "./runtime-protected-write.ts";

const cwd = "/workspace/project";

function runtimeConfig(filesystem = {}) {
  return {
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: {
      denyRead: [],
      allowRead: [],
      allowWrite: ["."],
      denyWrite: [],
      ...filesystem,
    },
  };
}

test("identifies runtime-protected writes inside configured writable paths", () => {
  assert.equal(
    isRuntimeProtectedWriteViolation(
      runtimeConfig(),
      { kind: "write", path: "/workspace/project/.git/hooks/pre-commit" },
      cwd,
    ),
    true,
  );
});

test("leaves configured policy violations actionable", () => {
  assert.equal(
    isRuntimeProtectedWriteViolation(
      runtimeConfig({ denyWrite: [".env"] }),
      { kind: "write", path: "/workspace/project/.env" },
      cwd,
    ),
    false,
  );
  assert.equal(
    isRuntimeProtectedWriteViolation(
      runtimeConfig({ allowWrite: [] }),
      { kind: "write", path: "/workspace/project/out.txt" },
      cwd,
    ),
    false,
  );
});

test("ignores reads, missing paths, and disabled filesystem isolation", () => {
  assert.equal(
    isRuntimeProtectedWriteViolation(
      runtimeConfig(),
      { kind: "read", path: "/workspace/project/.git/hooks/pre-commit" },
      cwd,
    ),
    false,
  );
  assert.equal(isRuntimeProtectedWriteViolation(runtimeConfig(), { kind: "write" }, cwd), false);
  assert.equal(
    isRuntimeProtectedWriteViolation(
      runtimeConfig({ disabled: true }),
      { kind: "write", path: "/workspace/project/.git/hooks/pre-commit" },
      cwd,
    ),
    false,
  );
});

test("deduplicates runtime-protected violations by path", () => {
  const first = { kind: "write", path: "/workspace/project/.git/hooks/pre-commit" };
  const duplicate = { kind: "write", path: first.path };
  const actionable = { kind: "write", path: "/outside/project.txt" };

  assert.deepEqual(
    getRuntimeProtectedWriteViolations(runtimeConfig(), [first, duplicate, actionable], cwd),
    [first],
  );
});
