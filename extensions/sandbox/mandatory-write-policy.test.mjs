import test from "node:test";
import assert from "node:assert/strict";

import { findMandatoryWriteRule } from "./mandatory-write-policy.ts";

const cwd = "/workspace/project";

test("protects dangerous files throughout the workspace", () => {
  assert.equal(findMandatoryWriteRule(`${cwd}/.bashrc`, cwd), ".bashrc");
  assert.equal(findMandatoryWriteRule(`${cwd}/nested/.mcp.json`, cwd), ".mcp.json");
  assert.equal(findMandatoryWriteRule(`${cwd}/nested/.GitModules`, cwd), ".gitmodules");
});

test("protects dangerous directories and Git hooks", () => {
  assert.equal(findMandatoryWriteRule(`${cwd}/.vscode/settings.json`, cwd), ".vscode");
  assert.equal(
    findMandatoryWriteRule(`${cwd}/nested/.claude/agents/reviewer.md`, cwd),
    ".claude/agents",
  );
  assert.equal(findMandatoryWriteRule(`${cwd}/nested/.git/hooks`, cwd), ".git/hooks");
  assert.equal(findMandatoryWriteRule(`${cwd}/nested/.git/hooks/pre-commit`, cwd), ".git/hooks");
});

test("honors the runtime Git config override", () => {
  const configPath = `${cwd}/nested/.git/config`;
  assert.equal(findMandatoryWriteRule(configPath, cwd), ".git/config");
  assert.equal(findMandatoryWriteRule(configPath, cwd, true), null);
});

test("does not extend mandatory rules outside the runtime workspace", () => {
  assert.equal(findMandatoryWriteRule("/workspace/other/.bashrc", cwd), null);
  assert.equal(findMandatoryWriteRule(`${cwd}/src/bashrc.ts`, cwd), null);
  assert.equal(findMandatoryWriteRule(`${cwd}/src/.vscode-theme.json`, cwd), null);
});
