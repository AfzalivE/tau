import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  Markdown,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";

import { ACP_AGENT_LABELS } from "./config.js";
import { PLAN_STATUS_ICONS, TOOL_STATUS_ICONS } from "./render.js";
import type { AcpRun } from "./runs.js";
import type { AcpTranscriptEntry } from "./types.js";

const MARKDOWN_THEME = getMarkdownTheme();
const ELAPSED_TICK_MS = 1000;

const STATUS_LABELS = {
  running: "running",
  done: "done",
  error: "error",
} as const;

/**
 * Scrollable overlay that tails one ACP run's transcript in real time.
 *
 * Subscribes to the run so every session update and the final completion
 * re-render the view. Tails to the bottom unless the user scrolls up.
 */
export class AcpSessionViewer implements Component {
  private scrollOffset = 0;
  private stickToBottom = true;
  private dirty = true;
  private confirmingStop = false;
  private stopRequested = false;
  private cachedWidth?: number;
  private cachedLines: string[] = [];
  private readonly unsubscribe: () => void;
  private readonly elapsedTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly run: AcpRun,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly onDone: () => void,
    /** Stops the underlying session. Omitted when the run cannot be stopped from here. */
    private readonly onStop?: () => void,
  ) {
    this.unsubscribe = run.subscribe(() => {
      this.dirty = true;
      this.tui.requestRender();
    });
    this.elapsedTimer = setInterval(() => {
      if (this.run.status === "running") this.tui.requestRender();
    }, ELAPSED_TICK_MS);
  }

  dispose(): void {
    this.unsubscribe();
    clearInterval(this.elapsedTimer);
  }

  invalidate(): void {
    this.dirty = true;
  }

  handleInput(data: string): void {
    if (this.confirmingStop) {
      if (data.toLowerCase() === "y") {
        this.confirmingStop = false;
        this.stopRequested = true;
        this.onStop?.();
      } else if (data.toLowerCase() === "n" || matchesKey(data, Key.escape)) {
        this.confirmingStop = false;
      } else {
        return;
      }
      this.tui.requestRender();
      return;
    }

    if (
      matchesKey(data, Key.enter) ||
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c")) ||
      data.toLowerCase() === "q"
    ) {
      this.onDone();
      return;
    }

    if (data.toLowerCase() === "s" && this.canStop()) {
      this.confirmingStop = true;
      this.tui.requestRender();
      return;
    }

    const bodyHeight = this.getBodyHeight();
    const boxWidth = this.getBoxWidth(this.tui.terminal.columns);
    const lines = this.getBodyLines(this.getContentWidth(boxWidth));
    const maxScroll = Math.max(0, lines.length - bodyHeight);

    if (matchesKey(data, Key.up) || data.toLowerCase() === "k") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    } else if (matchesKey(data, Key.down) || data.toLowerCase() === "j") {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
    } else if (matchesKey(data, Key.pageUp)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - Math.max(4, bodyHeight - 2));
    } else if (matchesKey(data, Key.pageDown)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + Math.max(4, bodyHeight - 2));
    } else if (matchesKey(data, Key.home)) {
      this.scrollOffset = 0;
    } else if (matchesKey(data, Key.end)) {
      this.scrollOffset = maxScroll;
    } else {
      return;
    }

    this.stickToBottom = this.scrollOffset >= maxScroll;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const boxWidth = this.getBoxWidth(width);
    const contentWidth = this.getContentWidth(boxWidth);
    const bodyHeight = this.getBodyHeight();
    const bodyLines = this.getBodyLines(contentWidth);
    const maxScroll = Math.max(0, bodyLines.length - bodyHeight);
    if (this.stickToBottom) this.scrollOffset = maxScroll;
    this.scrollOffset = clamp(this.scrollOffset, 0, maxScroll);

    const lines: string[] = [];
    lines.push(this.borderLine("╭", "╮", boxWidth));
    for (const headerLine of this.headerLines(contentWidth)) {
      lines.push(this.boxLine(headerLine, boxWidth));
    }
    lines.push(this.separatorLine(boxWidth));

    const visible = bodyLines.slice(this.scrollOffset, this.scrollOffset + bodyHeight);
    for (const line of visible) lines.push(this.boxLine(line, boxWidth));
    for (let i = visible.length; i < bodyHeight; i += 1) lines.push(this.boxLine("", boxWidth));

    lines.push(this.separatorLine(boxWidth));
    lines.push(
      this.boxLine(
        truncateToWidth(this.footer(bodyLines.length, visible.length), contentWidth),
        boxWidth,
      ),
    );
    lines.push(this.borderLine("╰", "╯", boxWidth));
    return lines;
  }

  private footer(totalLines: number, visibleLines: number): string {
    if (this.confirmingStop) {
      return (
        this.theme.fg("warning", `Stop ${this.run.label ?? this.run.agent}? `) +
        this.theme.fg("dim", "y / n")
      );
    }

    const range = `${Math.min(totalLines, this.scrollOffset + 1)}-${Math.min(totalLines, this.scrollOffset + visibleLines)}/${totalLines}`;
    const hints = ["↑↓ scroll", "End follow"];
    if (this.canStop()) hints.push("s stop");
    if (this.stopRequested && this.run.status === "running") hints.push("stopping…");
    hints.push("Enter/Esc close");
    const follow = this.stickToBottom ? this.theme.fg("success", " following") : "";
    return `${this.theme.fg("dim", hints.join(" · "))}${follow} ${this.theme.fg("muted", range)}`;
  }

  private canStop(): boolean {
    return this.onStop !== undefined && this.run.status === "running" && !this.stopRequested;
  }

  private headerLines(contentWidth: number): string[] {
    const label = this.theme.bold(this.run.label ?? ACP_AGENT_LABELS[this.run.agent]);
    const statusColor =
      this.run.status === "error" ? "error" : this.run.status === "done" ? "success" : "accent";
    const status = this.theme.fg(statusColor, STATUS_LABELS[this.run.status]);
    const elapsed = this.theme.fg("dim", formatElapsed(this.run.startedAt));
    const tools = this.run.recorder.toolCount;
    const toolStat =
      tools > 0 ? this.theme.fg("dim", ` · ${tools} tool${tools === 1 ? "" : "s"}`) : "";
    const title = `${this.theme.fg("toolTitle", label)}  ${status}  ${elapsed}${toolStat}`;

    const lines = [title];
    for (const line of wrapTextWithAnsi(this.theme.fg("muted", this.run.prompt), contentWidth)) {
      lines.push(line);
    }
    return lines;
  }

  private getBodyLines(contentWidth: number): string[] {
    if (!this.dirty && this.cachedWidth === contentWidth) return this.cachedLines;

    const lines: string[] = [];
    for (const entry of this.run.recorder.entries) {
      appendEntryLines(lines, entry, contentWidth, this.theme);
    }
    if (this.run.status === "error" && this.run.error) {
      lines.push("");
      for (const line of wrapTextWithAnsi(this.theme.fg("error", this.run.error), contentWidth)) {
        lines.push(line);
      }
    }
    if (!lines.length) {
      lines.push(this.theme.fg("muted", "Waiting for the agent…"));
    }

    this.cachedLines = lines;
    this.cachedWidth = contentWidth;
    this.dirty = false;
    return lines;
  }

  private getBodyHeight(): number {
    return Math.max(8, this.tui.terminal.rows - 14);
  }

  private getBoxWidth(width: number): number {
    return Math.max(50, Math.min(width - 2, 140));
  }

  private getContentWidth(boxWidth: number): number {
    return Math.max(10, boxWidth - 4);
  }

  private borderLine(left: string, right: string, width: number): string {
    return this.theme.fg("borderMuted", `${left}${"─".repeat(width - 2)}${right}`);
  }

  private separatorLine(width: number): string {
    return this.theme.fg("borderMuted", `├${"─".repeat(width - 2)}┤`);
  }

  private boxLine(content: string, width: number): string {
    const truncated = truncateToWidth(content, Math.max(1, width - 4), "");
    const padded = ` ${truncated}`;
    const rightPad = Math.max(0, width - 2 - visibleWidth(padded));
    return `${this.theme.fg("borderMuted", "│")}${padded}${" ".repeat(rightPad)}${this.theme.fg("borderMuted", "│")}`;
  }
}

function appendEntryLines(
  lines: string[],
  entry: AcpTranscriptEntry,
  width: number,
  theme: Theme,
): void {
  switch (entry.kind) {
    case "message":
      lines.push(...new Markdown(entry.text.trim(), 0, 0, MARKDOWN_THEME).render(width));
      lines.push("");
      break;
    case "thought":
      for (const line of wrapTextWithAnsi(theme.fg("thinkingText", entry.text.trim()), width)) {
        lines.push(line);
      }
      lines.push("");
      break;
    case "tool": {
      const icon = TOOL_STATUS_ICONS[entry.status];
      const color = entry.status === "failed" ? "error" : "muted";
      lines.push(theme.fg(color, truncateToWidth(`${icon} ${entry.title}`, width)));
      break;
    }
    case "plan":
      for (const item of entry.entries) {
        lines.push(
          theme.fg(
            "dim",
            truncateToWidth(`${PLAN_STATUS_ICONS[item.status]} ${item.content}`, width),
          ),
        );
      }
      break;
    case "permission":
      lines.push(
        theme.fg("warning", truncateToWidth(`? ${entry.title} → ${entry.decision}`, width)),
      );
      break;
  }
}

function formatElapsed(startedAt: number): string {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
