import type { ContentBlock, SessionUpdate } from "@agentclientprotocol/sdk";

import type { AcpTranscriptEntry } from "./types.js";

/**
 * Accumulates session/update notifications into a compact transcript.
 *
 * Message and thought chunks merge into the trailing entry of the same kind,
 * so tool calls naturally split the agent's output into segments. The last
 * message segment is the agent's final answer for the turn.
 */
export class TranscriptRecorder {
  readonly entries: AcpTranscriptEntry[] = [];
  private readonly toolEntryById = new Map<string, AcpTranscriptEntry & { kind: "tool" }>();

  handleUpdate(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        this.appendText("message", contentBlockText(update.content));
        break;
      case "agent_thought_chunk":
        this.appendText("thought", contentBlockText(update.content));
        break;
      case "tool_call": {
        const entry: AcpTranscriptEntry & { kind: "tool" } = {
          kind: "tool",
          toolCallId: update.toolCallId,
          title: update.title,
          toolKind: update.kind,
          status: update.status ?? "pending",
        };
        this.toolEntryById.set(update.toolCallId, entry);
        this.entries.push(entry);
        break;
      }
      case "tool_call_update": {
        const entry = this.toolEntryById.get(update.toolCallId);
        if (!entry) break;
        if (update.title != null) entry.title = update.title;
        if (update.kind != null) entry.toolKind = update.kind;
        if (update.status != null) entry.status = update.status;
        break;
      }
      case "plan":
      case "plan_update": {
        if (!("entries" in update) || !Array.isArray(update.entries)) break;
        const plan: AcpTranscriptEntry = {
          kind: "plan",
          entries: update.entries.map((entry) => ({
            content: entry.content,
            status: entry.status,
          })),
        };
        const lastPlanIndex = this.entries.findLastIndex((entry) => entry.kind === "plan");
        if (lastPlanIndex === this.entries.length - 1 && lastPlanIndex >= 0) {
          this.entries[lastPlanIndex] = plan;
        } else {
          this.entries.push(plan);
        }
        break;
      }
      default:
        break;
    }
  }

  recordPermission(title: string, decision: string): void {
    this.entries.push({ kind: "permission", title, decision });
  }

  /** The last message segment: the agent's final answer for the turn. */
  get finalText(): string {
    const message = this.entries.findLast((entry) => entry.kind === "message");
    return message?.kind === "message" ? message.text.trim() : "";
  }

  /** Short human-readable progress line for status displays. */
  get progressLabel(): string {
    const last = this.entries.at(-1);
    if (!last) return "starting...";
    switch (last.kind) {
      case "tool":
        return last.title;
      case "thought":
        return "thinking...";
      case "plan":
        return "planning...";
      default:
        return "responding...";
    }
  }

  get toolCount(): number {
    return this.toolEntryById.size;
  }

  private appendText(kind: "message" | "thought", text: string): void {
    if (!text) return;
    const last = this.entries.at(-1);
    if (last?.kind === kind) {
      last.text += text;
    } else {
      this.entries.push({ kind, text });
    }
  }
}

function contentBlockText(content: ContentBlock): string {
  switch (content.type) {
    case "text":
      return content.text;
    case "resource_link":
      return content.uri;
    default:
      return "";
  }
}
