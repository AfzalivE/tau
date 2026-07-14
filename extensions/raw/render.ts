type UnknownRecord = Record<string, unknown>;

const TRANSCRIPT_SEPARATOR = "\n\n---\n\n";

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nonEmptySections(sections: Array<string | undefined>): string[] {
  return sections.filter((section): section is string => Boolean(section && section.trim()));
}

function textContent(content: unknown): string {
  return asArray(content)
    .map((item) => {
      if (!isRecord(item)) return "";

      const type = asString(item.type);
      if (type === "text") return asString(item.text) ?? "";
      if (type === "image") {
        const mimeType = asString(item.mimeType);
        return mimeType ? `[image: ${mimeType}]` : "[image]";
      }

      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function messageContentRawText(content: unknown): string {
  return asString(content) ?? textContent(content);
}

function stringify(value: unknown): string | undefined {
  if (value === undefined) return undefined;

  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Remove terminal control sequences while retaining the transcript's text.
 * Raw mode must not let model or tool output alter terminal rendering.
 */
export function sanitizeRawText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][0-?]*[ -/]*[@-~]?/g, "")
    .replace(/[\u0000-\u0008\u000B-\u001A\u001C-\u001F\u007F-\u009F]/g, "");
}

export function assistantRawText(message: unknown, includeThinking = true): string {
  if (!isRecord(message)) return "";

  const content = asArray(message.content);
  const sections = content.flatMap((item) => {
    if (!isRecord(item)) return [];

    switch (item.type) {
      case "text": {
        const text = asString(item.text);
        return text?.trim() ? [text] : [];
      }
      case "thinking": {
        const thinking = asString(item.thinking);
        return includeThinking && thinking?.trim() ? [thinking] : [];
      }
      default:
        return [];
    }
  });

  const hasToolCalls = content.some((item) => isRecord(item) && item.type === "toolCall");
  const stopReason = asString(message.stopReason);
  const errorMessage = asString(message.errorMessage);

  if (stopReason === "length") {
    sections.push(
      "Error: Model stopped because it reached the maximum output token limit. The response may be incomplete.",
    );
  } else if (!hasToolCalls && stopReason === "aborted") {
    sections.push(
      errorMessage && errorMessage !== "Request was aborted" ? errorMessage : "Operation aborted",
    );
  } else if (!hasToolCalls && stopReason === "error") {
    sections.push(`Error: ${errorMessage ?? "Unknown error"}`);
  }

  return nonEmptySections(sections).join("\n\n");
}

export function toolRawText(
  name: unknown,
  args: unknown,
  result: unknown,
  isPartial: unknown,
): string {
  const toolName = asString(name) || "tool";
  const serializedArgs = stringify(args);
  const call = serializedArgs ? `${toolName} ${serializedArgs}` : toolName;

  const resultRecord = isRecord(result) ? result : undefined;
  const output = resultRecord ? textContent(resultRecord.content) : "";
  const pending = !resultRecord && isPartial ? "Running..." : "";

  return nonEmptySections([call, output, pending]).join("\n\n");
}

export function bashRawText(
  command: unknown,
  outputLines: unknown,
  status: unknown,
  exitCode: unknown,
): string {
  const sections = [`$ ${asString(command) ?? ""}`];
  const output = asArray(outputLines)
    .map(asString)
    .filter((line): line is string => line !== undefined)
    .join("\n");

  if (output) sections.push(output);

  if (status === "running") {
    sections.push("Running...");
  } else if (status === "cancelled") {
    sections.push("(cancelled)");
  } else if (status === "error") {
    sections.push(`(exit ${asString(exitCode) ?? String(exitCode ?? "unknown")})`);
  }

  return nonEmptySections(sections).join("\n\n");
}

export function customMessageRawText(message: unknown): string {
  if (!isRecord(message)) return "";

  const customType = asString(message.customType) ?? "custom";
  const content =
    asString(message.content) ??
    (Array.isArray(message.content) ? textContent(message.content) : "");

  return nonEmptySections([`[${customType}]`, content]).join("\n");
}

export function compactionRawText(message: unknown): string {
  if (!isRecord(message)) return "";

  const tokensBefore = message.tokensBefore;
  const label =
    typeof tokensBefore === "number"
      ? `Compacted from ${tokensBefore.toLocaleString()} tokens`
      : "Compaction";
  return nonEmptySections([label, asString(message.summary)]).join("\n\n");
}

export function branchSummaryRawText(message: unknown): string {
  if (!isRecord(message)) return "";

  return nonEmptySections(["Branch Summary", asString(message.summary)]).join("\n\n");
}

export function skillRawText(skillBlock: unknown): string {
  if (!isRecord(skillBlock)) return "";

  const name = asString(skillBlock.name);
  return name ? `[skill] ${name}` : "[skill]";
}

type PendingToolCall = {
  name: unknown;
  args: unknown;
};

/**
 * Render every entry on the active branch as source text. This deliberately
 * does not wrap lines: the terminal owns visual wrapping in the scrollback view.
 */
export function rawTranscript(
  entries: unknown[],
  options: { includeThinking?: boolean } = {},
): string {
  const sections: string[] = [];
  const pendingToolCalls = new Map<string, PendingToolCall>();

  for (const entry of entries) {
    if (!isRecord(entry)) continue;

    switch (entry.type) {
      case "message":
        appendMessage(entry.message, sections, pendingToolCalls, options.includeThinking ?? false);
        break;
      case "custom_message":
        if (entry.display === true) {
          sections.push(customMessageRawText(entry));
        }
        break;
      case "compaction":
        sections.push(compactionRawText(entry));
        break;
      case "branch_summary":
        sections.push(branchSummaryRawText(entry));
        break;
    }
  }

  for (const toolCall of pendingToolCalls.values()) {
    sections.push(toolRawText(toolCall.name, toolCall.args, undefined, false));
  }

  return nonEmptySections(sections).join(TRANSCRIPT_SEPARATOR);
}

/**
 * Format an unwrapped transcript for direct terminal output. CRLF appears only
 * where the source contains a newline; visual wrapping remains terminal-native.
 */
export function formatRawScrollback(transcript: string): string {
  const content = sanitizeRawText(transcript || "(No messages in the current branch.)").replace(
    /\n/g,
    "\r\n",
  );

  return [
    "\x1b[0m\x1b[?7h",
    "\r\n--- Pi raw transcript ---\r\n\r\n",
    content,
    "\r\n\r\n--- End raw transcript ---\r\nPress Enter to return to Pi.\r\n",
  ].join("");
}

function appendMessage(
  message: unknown,
  sections: string[],
  pendingToolCalls: Map<string, PendingToolCall>,
  includeThinking: boolean,
): void {
  if (!isRecord(message)) return;

  switch (message.role) {
    case "user":
      sections.push(messageContentRawText(message.content));
      return;
    case "assistant":
      sections.push(assistantRawText(message, includeThinking));
      addPendingToolCalls(message.content, pendingToolCalls);
      return;
    case "toolResult": {
      const toolCallId = asString(message.toolCallId);
      const toolCall = toolCallId ? pendingToolCalls.get(toolCallId) : undefined;
      sections.push(
        toolRawText(toolCall?.name ?? message.toolName, toolCall?.args, message, false),
      );
      if (toolCallId) pendingToolCalls.delete(toolCallId);
      return;
    }
    case "bashExecution": {
      const exitCode = message.exitCode;
      const status =
        message.cancelled === true
          ? "cancelled"
          : typeof exitCode === "number" && exitCode !== 0
            ? "error"
            : "complete";
      const output = asString(message.output) ?? "";
      sections.push(bashRawText(message.command, output.split("\n"), status, exitCode));
      return;
    }
    case "custom":
      if (message.display !== false) sections.push(customMessageRawText(message));
      return;
    case "compactionSummary":
      sections.push(compactionRawText(message));
      return;
    case "branchSummary":
      sections.push(branchSummaryRawText(message));
      return;
  }
}

function addPendingToolCalls(
  content: unknown,
  pendingToolCalls: Map<string, PendingToolCall>,
): void {
  for (const block of asArray(content)) {
    if (!isRecord(block) || block.type !== "toolCall") continue;

    const id = asString(block.id);
    if (!id) continue;
    pendingToolCalls.set(id, { name: block.name, args: block.arguments });
  }
}
