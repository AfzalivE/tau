import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { Text, TUI } from "../node_modules/@earendil-works/pi-tui/dist/index.js";

const extensionPath = fileURLToPath(new URL("./raw/index.ts", import.meta.url));
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

class RawOnlyInput extends EventEmitter {
  isRaw = false;
  paused = true;
  modeChanges = [];

  setRawMode(enabled) {
    this.isRaw = enabled;
    this.modeChanges.push(enabled);
    if (enabled) {
      setTimeout(() => {
        if (!this.paused && this.isRaw) this.emit("data", "\r");
      }, 1);
    }
  }

  resume() {
    this.paused = false;
    return this;
  }

  pause() {
    this.paused = true;
    return this;
  }
}

function replaceStdin(stdin) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "stdin");
  assert.ok(descriptor);
  Object.defineProperty(process, "stdin", { configurable: true, value: stdin });

  return () => Object.defineProperty(process, "stdin", descriptor);
}

function timeout(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RecordingTerminal {
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  writes = [];

  start(onInput, onResize) {
    this.onInput = onInput;
    this.onResize = onResize;
  }

  stop() {}

  async drainInput() {}

  write(data) {
    this.writes.push(data);
  }

  moveBy() {}

  hideCursor() {}

  showCursor() {}

  clearLine() {}

  clearFromCursor() {}

  clearScreen() {}

  setTitle() {}

  setProgress() {}
}

test("opens an unwrapped transcript in terminal scrollback and resumes Pi", async () => {
  const { extensions, errors } = await loadExtensions([extensionPath], projectRoot);
  assert.deepEqual(errors, []);

  const extension = extensions[0];
  assert.ok(extension);

  const sessionStart = extension.handlers.get("session_start")?.[0];
  const rawCommand = extension.commands.get("raw");
  assert.ok(sessionStart);
  assert.ok(rawCommand);

  const input = new RawOnlyInput();
  const restoreStdin = replaceStdin(input);
  const events = [];
  const writes = [];
  const tui = {
    terminal: {
      write: (text) => writes.push(text),
    },
    stop: () => {
      events.push("stop");
      input.pause();
      input.setRawMode(false);
    },
    start: () => events.push(`start:${input.isRaw}`),
    requestRender: () => {},
  };
  const notifications = [];
  const ctx = {
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    sessionManager: {
      getBranch: () => [
        { type: "message", message: { role: "user", content: "Show me the source." } },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "source line ".repeat(20).trim() }],
          },
        },
      ],
    },
    ui: {
      setWidget: (_key, content) => {
        if (typeof content === "function") content(tui, {});
      },
      notify: (message) => notifications.push(message),
    },
  };

  try {
    await sessionStart({}, ctx);
    const opening = rawCommand.handler("", ctx);
    const resumed = await Promise.race([opening.then(() => true), timeout(50).then(() => false)]);
    if (!resumed) {
      input.emit("data", "\r");
      await opening;
    }

    assert.equal(resumed, true, "Enter must resume Pi after its terminal has stopped.");
  } finally {
    restoreStdin();
  }

  const longLine = "source line ".repeat(20).trim();
  assert.deepEqual(events, ["stop", "start:false"]);
  assert.deepEqual(input.modeChanges, [false, true, false]);
  assert.equal(writes.length, 1);
  assert.ok(writes[0].includes(longLine));
  assert.deepEqual(notifications, []);

  await rawCommand.handler("on", ctx);
  assert.deepEqual(notifications, ["Usage: /raw"]);
});

test("restores rendering when raw interrupts a pending TUI render", async () => {
  const { extensions, errors } = await loadExtensions([extensionPath], projectRoot);
  assert.deepEqual(errors, []);

  const extension = extensions[0];
  assert.ok(extension);

  const sessionStart = extension.handlers.get("session_start")?.[0];
  const rawCommand = extension.commands.get("raw");
  assert.ok(sessionStart);
  assert.ok(rawCommand);

  const input = new RawOnlyInput();
  const restoreStdin = replaceStdin(input);
  const terminal = new RecordingTerminal();
  const tui = new TUI(terminal);
  tui.addChild(new Text("TUI renders again after raw"));
  tui.start();
  await timeout(30);

  const ctx = {
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    sessionManager: { getBranch: () => [] },
    ui: {
      setWidget: (_key, content) => {
        if (typeof content === "function") content(tui, {});
      },
      notify: () => {},
    },
  };

  try {
    await sessionStart({}, ctx);
    const writesBeforeRaw = terminal.writes.length;
    tui.requestRender();
    await rawCommand.handler("", ctx);
    await timeout(30);

    const resumedWrites = terminal.writes.slice(writesBeforeRaw).join("");
    assert.ok(resumedWrites.includes("TUI renders again after raw"));
  } finally {
    tui.stop();
    restoreStdin();
  }
});
