#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const verbose = process.env.DREAM_RENDER_VERBOSE === "1" || process.argv.includes("--verbose");
const colorsEnabled = process.env.NO_COLOR === undefined && process.env.DREAM_COLOR !== "0";
const color = (code, text) => (colorsEnabled ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = (text) => color("2", text);
const red = (text) => color("31", text);
const green = (text) => color("32", text);
const cyan = (text) => color("36", text);
const yellow = (text) => color("33", text);

process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

const rl = readline.createInterface({ input: process.stdin });
const toolCalls = new Map();
const toolOutputById = new Map();
let readBatch = [];
let atLineStart = true;
let printedTextForMessage = false;
let verboseAssistantText = "";
let verboseUsage = undefined;
let currentAssistantText = "";
let finalAssistantText = "";

const progress = createProgressRenderer();
if (!verbose) progress.start();

function write(text) {
  if (!text) return;
  process.stdout.write(text);
  atLineStart = text.endsWith("\n");
}

function writeLine(text = "") {
  if (!atLineStart) process.stdout.write("\n");
  process.stdout.write(`${text}\n`);
  atLineStart = true;
}

function compact(value, maxLength = 180) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function formatTokenCount(value) {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function formatUsage(usage) {
  if (!usage) return "";
  const input = Number(usage.input || 0);
  const output = Number(usage.output || 0);
  const cache = Number(usage.cacheRead || 0) + Number(usage.cacheWrite || 0);
  const total = Number(usage.totalTokens || input + output + cache);
  const parts = [`tok ${formatTokenCount(total)}`, `in ${formatTokenCount(input)}`, `out ${formatTokenCount(output)}`];
  if (cache > 0) parts.push(`cache ${formatTokenCount(cache)}`);
  return parts.join(" ");
}

function usageFromEvent(event) {
  return event?.assistantMessageEvent?.partial?.usage || event?.assistantMessageEvent?.message?.usage || event?.message?.usage;
}

function formatPath(args = {}) {
  if (!args.path) return "";
  const range = args.offset ? `:${args.offset}` : "";
  const limit = args.limit ? dim(` (${args.limit} lines)`) : "";
  return `${args.path}${range}${limit}`;
}

function formatToolCall(toolName, args = {}) {
  if (toolName === "bash") return compact(args.command || "", 220);
  if (toolName === "edit") {
    const count = Array.isArray(args.edits) ? dim(` (${plural(args.edits.length, "edit")})`) : "";
    return compact(`${args.path || ""}${count}`);
  }
  if (toolName === "write") return compact(args.path || "");
  if (toolName === "grep") return compact(`${args.pattern || ""} ${args.path || ""}`);
  if (toolName === "find") return compact(args.pattern || args.path || "");
  if (toolName === "ls") return compact(args.path || "");

  const serialized = JSON.stringify(args);
  return serialized && serialized !== "{}" ? compact(serialized) : "";
}

function textFromResult(result) {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content
    .filter((content) => content && content.type === "text" && typeof content.text === "string")
    .map((content) => content.text)
    .join("");
}

function textFromAssistantMessage(message) {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((content) => content && content.type === "text" && typeof content.text === "string")
    .map((content) => content.text)
    .join("");
}

function createProgressStream() {
  try {
    const fd = fs.openSync("/dev/tty", "w");
    const stream = fs.createWriteStream(null, { fd, autoClose: true });
    stream.on("error", () => {});
    return stream;
  } catch {
    return process.stderr;
  }
}

function createProgressRenderer() {
  const stream = createProgressStream();
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const state = {
    frame: 0,
    started: 0,
    finished: 0,
    failed: 0,
    readsStarted: 0,
    readsFinished: 0,
    edits: 0,
    writes: 0,
    current: "starting",
    usage: undefined,
    estimatedOutputTokens: 0,
    timer: undefined,
    active: false,
  };

  function stats() {
    const parts = [];
    if (state.readsStarted > 0) parts.push(`read ${state.readsFinished}/${state.readsStarted}`);
    if (state.edits > 0) parts.push(`edit ${state.edits}`);
    const usage = formatUsage(state.usage);
    if (usage) parts.push(usage);
    else if (state.estimatedOutputTokens > 0) parts.push(`~out ${formatTokenCount(state.estimatedOutputTokens)}`);
    if (state.writes > 0) parts.push(`write ${state.writes}`);
    parts.push(`tools ${state.finished}/${state.started}`);
    if (state.failed > 0) parts.push(red(`${state.failed} failed`));
    return parts.join(dim(" · "));
  }

  function render() {
    if (!state.active) return;
    const frame = cyan(frames[state.frame % frames.length]);
    state.frame += 1;
    const suffix = state.current ? `${dim(" · ")}${compact(state.current, 70)}` : "";
    stream.write(`\r\x1b[K${frame} ${cyan("Dreaming")} ${dim(stats())}${suffix}`);
  }

  return {
    start() {
      if (state.active) return;
      state.active = true;
      render();
      state.timer = setInterval(render, 120);
    },
    stop() {
      if (!state.active) return;
      state.active = false;
      clearInterval(state.timer);
      stream.write("\r\x1b[K");
    },
    nonJson(line) {
      this.stop();
      writeLine(line);
      this.start();
    },
    toolStarted(event) {
      state.started += 1;
      if (event.toolName === "read") state.readsStarted += 1;
      if (event.toolName === "edit") state.edits += 1;
      if (event.toolName === "write") state.writes += 1;
      const details = event.toolName === "read" ? formatPath(event.args) : formatToolCall(event.toolName, event.args);
      state.current = details ? `${event.toolName} ${details}` : event.toolName;
      render();
    },
    toolFinished(event) {
      state.finished += 1;
      if (event.toolName === "read") state.readsFinished += 1;
      if (event.isError) state.failed += 1;
      state.current = `${event.toolName} ${event.isError ? "failed" : "done"}`;
      render();
    },
    assistantUpdated(event, assistantText) {
      const usage = usageFromEvent(event);
      if (usage) state.usage = usage;
      state.estimatedOutputTokens = Math.ceil(assistantText.length / 4);
      render();
    },
  };
}

function allReadsFinished() {
  return readBatch.length > 0 && readBatch.every((call) => call.done);
}

function flushReadBatch({ force = false } = {}) {
  if (readBatch.length === 0) return;
  if (!force && !allReadsFinished()) return;

  const batch = readBatch;
  readBatch = [];
  const failures = batch.filter((call) => call.isError);
  const shown = batch.slice(0, 8);
  const hiddenCount = batch.length - shown.length;

  writeLine(`${dim("╭─")} ${cyan("read")} ${dim(`×${batch.length}`)}`);
  for (const call of shown) {
    const icon = call.done ? (call.isError ? red("✗") : dim("•")) : yellow("…");
    writeLine(`${dim("│")} ${icon} ${formatPath(call.args)}`);
  }
  if (hiddenCount > 0) {
    writeLine(`${dim("│")} ${dim(`… ${plural(hiddenCount, "more file")}`)}`);
  }

  if (failures.length > 0) {
    writeLine(`${dim("╰─")} ${red(`✗ ${failures.length}/${batch.length} failed`)}`);
  } else if (batch.every((call) => call.done)) {
    writeLine(`${dim("╰─")} ${green(`✓ ${plural(batch.length, "file")}`)}`);
  } else {
    writeLine(`${dim("╰─")} ${yellow(`${batch.filter((call) => call.done).length}/${batch.length} finished`)}`);
  }
}

function startRead(event) {
  if (allReadsFinished()) flushReadBatch();

  const call = {
    id: event.toolCallId,
    name: event.toolName,
    args: event.args || {},
    done: false,
    isError: false,
  };
  toolCalls.set(event.toolCallId, call);
  readBatch.push(call);
}

function finishRead(event) {
  const call = toolCalls.get(event.toolCallId);
  if (call) {
    call.done = true;
    call.isError = Boolean(event.isError);
  }
  flushReadBatch();
}

function startTool(event) {
  flushReadBatch();

  const call = {
    id: event.toolCallId,
    name: event.toolName,
    args: event.args || {},
    outputLineStart: true,
  };
  toolCalls.set(event.toolCallId, call);

  const details = formatToolCall(event.toolName, call.args);
  writeLine(`${dim("╭─")} ${cyan(event.toolName)}${details ? ` ${dim("·")} ${details}` : ""}`);
}

function writeBoxedOutput(call, text) {
  if (!text) return;

  if (!atLineStart) {
    process.stdout.write("\n");
    atLineStart = true;
  }

  for (const char of text) {
    if (call.outputLineStart) {
      process.stdout.write(`${dim("│")} `);
      call.outputLineStart = false;
    }

    process.stdout.write(char);

    if (char === "\n") {
      atLineStart = true;
      call.outputLineStart = true;
    } else {
      atLineStart = false;
    }
  }
}

function writeToolOutputDelta(toolCallId, result, options = {}) {
  const current = textFromResult(result);
  if (!current) return;

  const hasPrevious = toolOutputById.has(toolCallId);
  if (options.onlyIfStarted && !hasPrevious) return;

  const previous = hasPrevious ? toolOutputById.get(toolCallId) : "";
  const delta = current.startsWith(previous) ? current.slice(previous.length) : current;
  const call = toolCalls.get(toolCallId);
  if (call) writeBoxedOutput(call, delta);
  else write(delta);
  toolOutputById.set(toolCallId, current);
}

function finishTool(event) {
  const call = toolCalls.get(event.toolCallId) || { name: event.toolName, outputLineStart: true };
  const shouldPrintFinalOutput = event.isError || call.name === "bash" || toolOutputById.has(event.toolCallId);
  writeToolOutputDelta(event.toolCallId, event.result, { onlyIfStarted: !shouldPrintFinalOutput });

  writeLine(`${dim("╰─")} ${event.isError ? red("✗") : green("✓")} ${event.toolName}`);
}

function printVerboseUsage(usage, assistantText) {
  const usageText = formatUsage(usage);
  if (usageText) {
    writeLine(dim(`· ${usageText}`));
    return;
  }

  const estimatedOutputTokens = Math.ceil((assistantText || "").length / 4);
  if (estimatedOutputTokens > 0) {
    writeLine(dim(`· ~out ${formatTokenCount(estimatedOutputTokens)}`));
  }
}

function handleVerboseEvent(event) {
  if (event.type === "message_start") {
    printedTextForMessage = false;
    verboseAssistantText = "";
    verboseUsage = usageFromEvent(event);
    return;
  }

  if (event.type === "message_update") {
    const usage = usageFromEvent(event);
    if (usage) verboseUsage = usage;

    const delta = event.assistantMessageEvent;
    if (delta && delta.type === "text_delta" && typeof delta.delta === "string") {
      flushReadBatch();
      verboseAssistantText += delta.delta;
      write(delta.delta);
      printedTextForMessage = true;
    }
    return;
  }

  if (event.type === "message_end") {
    const text = textFromAssistantMessage(event.message) || verboseAssistantText;
    const usage = usageFromEvent(event) || verboseUsage;
    if (text && !printedTextForMessage) {
      flushReadBatch();
      write(text);
    }
    printVerboseUsage(usage, text);
    return;
  }

  if (event.type === "tool_execution_start") {
    if (event.toolName === "read") startRead(event);
    else startTool(event);
    return;
  }

  if (event.type === "tool_execution_update") {
    writeToolOutputDelta(event.toolCallId, event.partialResult);
    return;
  }

  if (event.type === "tool_execution_end") {
    if (event.toolName === "read") finishRead(event);
    else finishTool(event);
  }
}

function handleProgressEvent(event) {
  if (event.type === "message_start") {
    currentAssistantText = "";
    return;
  }

  if (event.type === "message_update") {
    const delta = event.assistantMessageEvent;
    if (delta && delta.type === "text_delta" && typeof delta.delta === "string") {
      currentAssistantText += delta.delta;
    }
    progress.assistantUpdated(event, currentAssistantText);
    return;
  }

  if (event.type === "message_end") {
    const text = textFromAssistantMessage(event.message) || currentAssistantText;
    if (text.trim()) finalAssistantText = text;
    progress.assistantUpdated(event, text);
    return;
  }

  if (event.type === "tool_execution_start") {
    progress.toolStarted(event);
    return;
  }

  if (event.type === "tool_execution_end") {
    progress.toolFinished(event);
  }
}

rl.on("line", (line) => {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    if (verbose) {
      flushReadBatch({ force: true });
      writeLine(line);
    } else {
      progress.nonJson(line);
    }
    return;
  }

  if (verbose) handleVerboseEvent(event);
  else handleProgressEvent(event);
});

rl.on("close", () => {
  if (verbose) {
    flushReadBatch({ force: true });
    return;
  }

  progress.stop();
  if (finalAssistantText.trim()) {
    write(finalAssistantText.endsWith("\n") ? finalAssistantText : `${finalAssistantText}\n`);
  }
});
