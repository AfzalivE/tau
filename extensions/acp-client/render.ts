import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";

import { ACP_AGENT_LABELS } from "./config.js";
import type { AcpAgentId, AcpToolDetails, AcpTranscriptEntry } from "./types.js";

const CALL_PREVIEW_LENGTH = 80;

export const TOOL_STATUS_ICONS = {
  pending: "○",
  in_progress: "◐",
  completed: "●",
  failed: "✗",
} as const;

export const PLAN_STATUS_ICONS = {
  pending: "○",
  in_progress: "◐",
  completed: "●",
} as const;

export function renderAcpCall(
  agent: AcpAgentId,
  prompt: string,
  sessionId: string | undefined,
  theme: Theme,
): Text {
  const preview = prompt.replace(/\s+/g, " ").trim();
  const truncated =
    preview.length > CALL_PREVIEW_LENGTH
      ? `${preview.slice(0, CALL_PREVIEW_LENGTH - 1)}…`
      : preview;
  const resumed = sessionId ? theme.fg("dim", " (resumed)") : "";
  return new Text(
    `${theme.fg("toolTitle", theme.bold(ACP_AGENT_LABELS[agent]))}${resumed} ${theme.fg("muted", truncated)}`,
    0,
    0,
  );
}

export function renderAcpResult(
  details: AcpToolDetails,
  text: string,
  expanded: boolean,
  isError: boolean,
  theme: Theme,
): Container | Text {
  if (!expanded) {
    const summary = summarizeResult(details, text, isError, theme);
    return new Text(summary, 0, 0);
  }

  const container = new Container();
  container.addChild(new Spacer(1));
  for (const entry of details.entries) {
    appendEntry(container, entry, theme);
  }
  if (!details.entries.length) {
    container.addChild(new Text(theme.fg("muted", text.trim() || "(no output)"), 0, 0));
  }
  return container;
}

function summarizeResult(
  details: AcpToolDetails,
  text: string,
  isError: boolean,
  theme: Theme,
): string {
  if (isError) {
    const firstLine = text.trim().split("\n")[0] ?? "failed";
    return theme.fg("error", firstLine);
  }

  const toolCount = details.entries.filter((entry) => entry.kind === "tool").length;
  const finalMessage = details.entries.findLast((entry) => entry.kind === "message");
  const preview =
    finalMessage?.kind === "message"
      ? (finalMessage.text.trim().split("\n")[0] ?? "")
      : "(no response)";
  const stats: string[] = [];
  if (toolCount > 0) stats.push(`${toolCount} tool ${toolCount === 1 ? "call" : "calls"}`);
  if (details.stopReason && details.stopReason !== "end_turn") stats.push(details.stopReason);
  const suffix = stats.length ? theme.fg("dim", ` · ${stats.join(" · ")}`) : "";
  return `${theme.fg("muted", preview)}${suffix}`;
}

function appendEntry(container: Container, entry: AcpTranscriptEntry, theme: Theme): void {
  switch (entry.kind) {
    case "message":
      container.addChild(new Markdown(entry.text.trim(), 0, 0, getMarkdownTheme()));
      container.addChild(new Spacer(1));
      break;
    case "thought":
      container.addChild(new Text(theme.fg("thinkingText", entry.text.trim()), 0, 0));
      container.addChild(new Spacer(1));
      break;
    case "tool": {
      const icon = TOOL_STATUS_ICONS[entry.status];
      const color = entry.status === "failed" ? "error" : "muted";
      container.addChild(new Text(theme.fg(color, `${icon} ${entry.title}`), 0, 0));
      break;
    }
    case "plan":
      for (const item of entry.entries) {
        container.addChild(
          new Text(theme.fg("dim", `${PLAN_STATUS_ICONS[item.status]} ${item.content}`), 0, 0),
        );
      }
      break;
    case "permission":
      container.addChild(
        new Text(theme.fg("warning", `? ${entry.title} → ${entry.decision}`), 0, 0),
      );
      break;
  }
}
