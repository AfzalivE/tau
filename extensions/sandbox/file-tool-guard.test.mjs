import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findFileToolPolicyViolation,
  getFileToolAccesses,
  guardFileToolCall,
  resolveFileToolAccesses,
} from "./file-tool-guard.ts";

const cwd = "/workspace/project";

function runtimeConfig(filesystem) {
  return {
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: {
      denyRead: [],
      allowRead: [],
      allowWrite: [],
      denyWrite: [],
      ...filesystem,
    },
  };
}

test("maps native file tools to their filesystem access requirements", () => {
  assert.deepEqual(getFileToolAccesses("read", { path: "notes.md" }, cwd), [
    { kind: "read", readAccess: "data", path: "/workspace/project/notes.md" },
  ]);
  assert.deepEqual(getFileToolAccesses("write", { path: "notes.md" }, cwd), [
    { kind: "write", path: "/workspace/project/notes.md" },
  ]);
  assert.deepEqual(getFileToolAccesses("edit", { path: "notes.md" }, cwd), [
    { kind: "read", readAccess: "data", path: "/workspace/project/notes.md" },
    { kind: "write", path: "/workspace/project/notes.md" },
  ]);
  assert.deepEqual(getFileToolAccesses("grep", {}, cwd), [
    { kind: "read", readAccess: "data", traverses: true, path: cwd },
  ]);
  assert.deepEqual(getFileToolAccesses("find", { path: "src" }, cwd), [
    {
      kind: "read",
      readAccess: "metadata",
      traverses: true,
      path: "/workspace/project/src",
    },
  ]);
  assert.deepEqual(getFileToolAccesses("ls", {}, cwd), [
    { kind: "read", readAccess: "metadata", traverses: true, path: cwd },
  ]);
  assert.deepEqual(getFileToolAccesses("read", { path: "file:///workspace/private/token" }, cwd), [
    { kind: "read", readAccess: "data", path: "/workspace/private/token" },
  ]);
  assert.equal(getFileToolAccesses("bash", { command: "cat notes.md" }, cwd), null);
});

test("uses sandbox read and write precedence", () => {
  const config = runtimeConfig({
    denyRead: ["/workspace/private"],
    allowRead: ["/workspace/private/shared"],
    allowWrite: ["."],
    denyWrite: [".env", "locked"],
  });

  const privateRead = getFileToolAccesses("read", { path: "/workspace/private/token" }, cwd);
  assert.equal(findFileToolPolicyViolation(privateRead, config, cwd)?.reason, "explicit-deny-read");

  const allowedRead = getFileToolAccesses("read", { path: "/workspace/private/shared/info" }, cwd);
  assert.equal(findFileToolPolicyViolation(allowedRead, config, cwd), null);

  const allowedWrite = getFileToolAccesses("write", { path: "src/new.ts" }, cwd);
  assert.equal(findFileToolPolicyViolation(allowedWrite, config, cwd), null);

  const deniedWrite = getFileToolAccesses("write", { path: ".env" }, cwd);
  assert.equal(
    findFileToolPolicyViolation(deniedWrite, config, cwd)?.reason,
    "explicit-deny-write",
  );

  const outsideWrite = getFileToolAccesses("write", { path: "/tmp/new.txt" }, cwd);
  assert.equal(
    findFileToolPolicyViolation(outsideWrite, config, cwd)?.reason,
    "missing-allow-write",
  );
});

test("blocks recursive file tools that could traverse into denied paths", () => {
  const grep = getFileToolAccesses("grep", { path: "/workspace" }, cwd);
  assert.deepEqual(
    findFileToolPolicyViolation(grep, runtimeConfig({ denyRead: ["/workspace/private"] }), cwd),
    {
      access: { kind: "read", readAccess: "data", traverses: true, path: "/workspace" },
      reason: "explicit-deny-read",
      matchedRule: "/workspace/private",
    },
  );
  assert.equal(
    findFileToolPolicyViolation(
      grep,
      runtimeConfig({
        denyRead: ["/workspace/private"],
        allowRead: ["/workspace/private"],
      }),
      cwd,
    ),
    null,
  );
});

test("blocks a native file tool when permission is denied", async () => {
  const result = await guardFileToolCall({
    toolName: "read",
    input: { path: "/workspace/private/token" },
    cwd,
    getRuntimeConfig: () => runtimeConfig({ denyRead: ["/workspace/private"] }),
    onViolation: async (violation) => {
      assert.equal(violation.reason, "explicit-deny-read");
      return { allow: false, reason: "Sandbox denied this read." };
    },
  });

  assert.deepEqual(result, { block: true, reason: "Sandbox denied this read." });
});

test("requires edit to satisfy both its read and write policy", async () => {
  const result = await guardFileToolCall({
    toolName: "edit",
    input: { path: "locked/notes.md" },
    cwd,
    getRuntimeConfig: () => runtimeConfig({ allowWrite: ["."], denyWrite: ["locked"] }),
    onViolation: async (violation) => {
      assert.equal(violation.access.kind, "write");
      assert.equal(violation.reason, "explicit-deny-write");
      return { allow: false, reason: "Sandbox denied this edit." };
    },
  });

  assert.deepEqual(result, { block: true, reason: "Sandbox denied this edit." });
});

test("rechecks a native file tool after a session permission is granted", async () => {
  let config = runtimeConfig({ allowWrite: [] });
  const result = await guardFileToolCall({
    toolName: "write",
    input: { path: "notes.md" },
    cwd,
    getRuntimeConfig: () => config,
    onViolation: async (violation) => {
      assert.equal(violation.reason, "missing-allow-write");
      config = runtimeConfig({ allowWrite: ["."] });
      return { allow: true };
    },
  });

  assert.equal(result, null);
});

test("canonicalizes existing and new paths through symlinked ancestors", async () => {
  const root = await mkdtemp(join(tmpdir(), "tau-file-tool-guard-"));
  const workspace = join(root, "workspace");
  const protectedDir = join(root, "protected");

  try {
    await mkdir(workspace);
    await mkdir(protectedDir);
    await writeFile(join(protectedDir, "secret.txt"), "secret");
    await symlink(protectedDir, join(workspace, "linked"));

    const canonicalProtectedDir = await realpath(protectedDir);

    const linkedRead = await resolveFileToolAccesses(
      "read",
      { path: "linked/secret.txt" },
      workspace,
    );
    assert.deepEqual(linkedRead, [
      { kind: "read", readAccess: "data", path: join(canonicalProtectedDir, "secret.txt") },
    ]);
    assert.equal(
      findFileToolPolicyViolation(
        linkedRead,
        runtimeConfig({ denyRead: [canonicalProtectedDir], allowWrite: [workspace] }),
        workspace,
      )?.reason,
      "explicit-deny-read",
    );

    const linkedWrite = await resolveFileToolAccesses(
      "write",
      { path: "linked/new.txt" },
      workspace,
    );
    assert.deepEqual(linkedWrite, [
      { kind: "write", path: join(canonicalProtectedDir, "new.txt") },
    ]);
    assert.equal(
      findFileToolPolicyViolation(
        linkedWrite,
        runtimeConfig({ allowWrite: [workspace] }),
        workspace,
      )?.reason,
      "missing-allow-write",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
