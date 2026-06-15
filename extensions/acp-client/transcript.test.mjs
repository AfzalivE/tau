import assert from "node:assert/strict";
import test from "node:test";

import { TranscriptRecorder } from "./transcript.ts";

function messageChunk(text) {
  return { sessionUpdate: "agent_message_chunk", content: { type: "text", text } };
}

function thoughtChunk(text) {
  return { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } };
}

test("merges consecutive message chunks into one entry", () => {
  const recorder = new TranscriptRecorder();
  recorder.handleUpdate(messageChunk("Hello"));
  recorder.handleUpdate(messageChunk(" world"));

  assert.deepEqual(recorder.entries, [{ kind: "message", text: "Hello world" }]);
  assert.equal(recorder.finalText, "Hello world");
});

test("tool calls split message segments and finalText returns the last segment", () => {
  const recorder = new TranscriptRecorder();
  recorder.handleUpdate(messageChunk("Let me check."));
  recorder.handleUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    title: "Read config.ts",
    kind: "read",
    status: "pending",
  });
  recorder.handleUpdate(messageChunk("All done."));

  assert.equal(recorder.entries.length, 3);
  assert.equal(recorder.toolCount, 1);
  assert.equal(recorder.finalText, "All done.");
});

test("tool_call_update mutates the matching tool entry in place", () => {
  const recorder = new TranscriptRecorder();
  recorder.handleUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    title: "Run tests",
    status: "pending",
  });
  recorder.handleUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "t1",
    status: "completed",
  });

  assert.deepEqual(recorder.entries, [
    {
      kind: "tool",
      toolCallId: "t1",
      title: "Run tests",
      toolKind: undefined,
      status: "completed",
    },
  ]);
});

test("plan updates replace a trailing plan rather than appending", () => {
  const recorder = new TranscriptRecorder();
  recorder.handleUpdate({
    sessionUpdate: "plan",
    entries: [{ content: "Step 1", priority: "high", status: "pending" }],
  });
  recorder.handleUpdate({
    sessionUpdate: "plan_update",
    entries: [{ content: "Step 1", priority: "high", status: "completed" }],
  });

  assert.deepEqual(recorder.entries, [
    { kind: "plan", entries: [{ content: "Step 1", status: "completed" }] },
  ]);
});

test("thought chunks accumulate separately from messages", () => {
  const recorder = new TranscriptRecorder();
  recorder.handleUpdate(thoughtChunk("thinking..."));
  recorder.handleUpdate(messageChunk("answer"));

  assert.deepEqual(recorder.entries, [
    { kind: "thought", text: "thinking..." },
    { kind: "message", text: "answer" },
  ]);
  assert.equal(recorder.progressLabel, "responding...");
});

test("recordPermission appends a permission entry", () => {
  const recorder = new TranscriptRecorder();
  recorder.recordPermission("Write file", "allow once");

  assert.deepEqual(recorder.entries, [
    { kind: "permission", title: "Write file", decision: "allow once" },
  ]);
});
