import test from "node:test";
import assert from "node:assert/strict";

import {
  SANDBOX_ALLOW_ADAPT_OPTION,
  SANDBOX_ALLOW_RETRY_OPTION,
  SANDBOX_DENY_OPTION,
  formatSandboxPermissionConfirmMessage,
  formatSandboxPermissionPromptTitle,
  getViolationPromptOptions,
  parseViolationPromptSelection,
} from "./prompt-ui.ts";

test("builds retry-aware sandbox violation prompt options", () => {
  assert.equal(SANDBOX_ALLOW_RETRY_OPTION, "Allow and retry now");
  assert.equal(SANDBOX_ALLOW_ADAPT_OPTION, "Allow but adapt for side-effects");
  assert.equal(SANDBOX_DENY_OPTION, "Deny");
  assert.deepEqual(getViolationPromptOptions(true), [
    SANDBOX_ALLOW_RETRY_OPTION,
    SANDBOX_ALLOW_ADAPT_OPTION,
    SANDBOX_DENY_OPTION,
  ]);
  assert.deepEqual(getViolationPromptOptions(false), [
    SANDBOX_ALLOW_ADAPT_OPTION,
    SANDBOX_DENY_OPTION,
  ]);
});

test("parses sandbox violation prompt selections", () => {
  assert.equal(parseViolationPromptSelection(SANDBOX_ALLOW_RETRY_OPTION, true), "allow-retry");
  assert.equal(parseViolationPromptSelection(SANDBOX_ALLOW_RETRY_OPTION, false), "deny");
  assert.equal(parseViolationPromptSelection(SANDBOX_ALLOW_ADAPT_OPTION, false), "allow-adapt");
  assert.equal(parseViolationPromptSelection(undefined, true), "deny");
});

test("formats sandbox permission prompt details", () => {
  const title = formatSandboxPermissionPromptTitle({
    title: "Sandbox blocked filesystem access",
    request: "Filesystem write",
    target: "/Users/example/.cache/tool",
    requester: "node",
    command: "npm install example",
    sandboxChange: "Add allow-write rule /Users/example/.cache/tool",
    equivalentCommand: "/sandbox filesystem allow-write add /Users/example/.cache/tool",
  });

  assert.match(title, /^⛔  Sandbox blocked filesystem access\nFilesystem write/m);
  assert.match(title, /Target:\n  \/Users\/example\/\.cache\/tool/);
  assert.match(title, /Triggered by: node via npm install example/);
  assert.match(
    title,
    /Allowing this will:\n  Add allow-write rule \/Users\/example\/\.cache\/tool/,
  );
  assert.doesNotMatch(title, /Equivalent command:/);
  assert.match(title, /Scope: Session only; sandbox config files are not changed\./);
});

test("formats confirm messages without duplicating the dialog title", () => {
  const message = formatSandboxPermissionConfirmMessage({
    title: "Sandbox blocked network access",
    request: "Network connection",
    target: "api.example.com:443",
    sandboxChange: "Add allowed network domain api.example.com",
    equivalentCommand: "/sandbox network allow add api.example.com",
  });

  assert.doesNotMatch(message, /^Sandbox blocked network access/);
  assert.match(message, /^Network connection/m);
  assert.match(message, /\n\nAllow for this session\?$/);
});
