import assert from "node:assert/strict";
import test from "node:test";

import {
  assistantRawText,
  bashRawText,
  customMessageRawText,
  formatRawScrollback,
  rawTranscript,
  sanitizeRawText,
  toolRawText,
} from "./render.ts";

test("sanitizes terminal control sequences without changing transcript text", () => {
  assert.equal(
    sanitizeRawText("one\r\ntwo\x1b[31m red\x1b[0m\x1b]8;;https://example.com\x07link\x1b]8;;\x07"),
    "one\ntwo redlink",
  );
});

test("keeps assistant text and thinking in raw transcript order", () => {
  assert.equal(
    assistantRawText({
      content: [
        { type: "thinking", thinking: "reasoning" },
        { type: "text", text: "## Result\n\n`value`" },
      ],
    }),
    "reasoning\n\n## Result\n\n`value`",
  );
});

test("respects Pi's hidden-thinking setting", () => {
  assert.equal(
    assistantRawText(
      {
        content: [
          { type: "thinking", thinking: "hidden reasoning" },
          { type: "text", text: "visible response" },
        ],
      },
      false,
    ),
    "visible response",
  );
});

test("includes terminal assistant errors when there are no tool calls", () => {
  assert.equal(
    assistantRawText({ content: [], stopReason: "error", errorMessage: "provider unavailable" }),
    "Error: provider unavailable",
  );
});

test("renders tool calls and text or image results without rich framing", () => {
  assert.equal(
    toolRawText(
      "read",
      { path: "notes.md" },
      {
        content: [
          { type: "text", text: "# Notes" },
          { type: "image", mimeType: "image/png" },
        ],
      },
      false,
    ),
    'read {\n  "path": "notes.md"\n}\n\n# Notes\n[image: image/png]',
  );
});

test("renders user bash output and errors as plain text", () => {
  assert.equal(
    bashRawText("git status", [" M extensions/raw/index.ts"], "error", 1),
    "$ git status\n\n M extensions/raw/index.ts\n\n(exit 1)",
  );
});

test("renders custom messages without their rich box", () => {
  assert.equal(
    customMessageRawText({ customType: "notice", content: "Reload complete" }),
    "[notice]\nReload complete",
  );
});

test("separates rendered transcript entries without leading or trailing rules", () => {
  assert.equal(
    rawTranscript([
      { type: "message", message: { role: "user", content: "First message" } },
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "Second message" }] },
      },
    ]),
    "First message\n\n---\n\nSecond message",
  );
});

test("keeps prior transcript lines unwrapped for terminal scrollback", () => {
  const longLine = "unbroken source line ".repeat(12).trim();
  const transcript = rawTranscript([
    { type: "message", message: { role: "user", content: "Inspect this." } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: longLine },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "notes.md" } },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "# Notes" }],
      },
    },
    {
      type: "message",
      message: {
        role: "bashExecution",
        command: "git status",
        output: " M notes.md",
        exitCode: 0,
        cancelled: false,
      },
    },
  ]);

  assert.ok(transcript.split("\n").includes(longLine));
  assert.ok(formatRawScrollback(longLine).includes(longLine));
  assert.match(transcript, /read \{\n  "path": "notes.md"\n\}/);
  assert.match(transcript, /# Notes/);
  assert.match(transcript, /\$ git status/);
});
