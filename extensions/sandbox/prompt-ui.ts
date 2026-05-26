import { keyHint, rawKeyHint } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SelectList, truncateToWidth, visibleWidth, type SelectItem } from "@earendil-works/pi-tui";
import type { ViolationResolutionKind } from "./types.js";

const DEFAULT_PROMPT_SCOPE = "Session only; sandbox config files are not changed.";
const PROMPT_VALUE_LIMIT = 260;
const PANEL_MAX_WIDTH = 96;
const PANEL_MIN_WIDTH = 52;
const LABEL_WIDTH = 9;

export const SANDBOX_ALLOW_RETRY_OPTION = "Allow and retry now";
export const SANDBOX_ALLOW_ADAPT_OPTION = "Allow but adapt for side-effects";
export const SANDBOX_DENY_OPTION = "Deny";

export interface SandboxPermissionPromptDetails {
  title: string;
  request: string;
  target?: string;
  targetLabel?: string;
  requester?: string;
  command?: string;
  sandboxChange?: string;
  equivalentCommand?: string;
  typeCode?: string;
  scope?: string;
  extra?: string;
}

type SandboxPromptTheme = ExtensionContext["ui"]["theme"];

export async function showSandboxPermissionSelect(
  ctx: ExtensionContext,
  details: SandboxPermissionPromptDetails,
  options: string[],
): Promise<string | undefined> {
  const result = await ctx.ui.custom<string | null | undefined>(
    (tui, theme, _keybindings, done) => {
      const selectList = new SelectList(
        options.map((option): SelectItem => ({ value: option, label: option })),
        Math.min(options.length, 6),
        {
          selectedPrefix: (text: string) => theme.fg("warning", text),
          selectedText: (text: string) => theme.fg("warning", theme.bold(text)),
          description: (text: string) => theme.fg("muted", text),
          scrollInfo: (text: string) => theme.fg("dim", text),
          noMatch: (text: string) => theme.fg("warning", text),
        },
      );
      selectList.onSelect = (item) => done(item.value);
      selectList.onCancel = () => done(null);

      return {
        render: (width: number) => [
          ...renderSandboxPermissionPanel(details, width, theme),
          "",
          ...selectList.render(Math.min(width, PANEL_MAX_WIDTH)),
          theme.fg(
            "dim",
            `  ${rawKeyHint("↑↓", "navigate")}  ${keyHint("tui.select.confirm", "select")}  ${keyHint("tui.select.cancel", "cancel")}`,
          ),
        ],
        invalidate: () => selectList.invalidate(),
        handleInput: (data: string) => {
          selectList.handleInput(data);
          tui.requestRender();
        },
      };
    },
  );

  if (result !== undefined) return result ?? undefined;
  return ctx.ui.select(formatSandboxPermissionPromptTitle(details), options);
}

export async function showSandboxPermissionConfirm(
  ctx: ExtensionContext,
  details: SandboxPermissionPromptDetails,
): Promise<boolean> {
  const result = await showSandboxPermissionSelect(ctx, details, ["Yes", "No"]);
  if (result === undefined) return false;
  return result === "Yes";
}

export function getViolationPromptOptions(autoRetryAvailable: boolean): string[] {
  if (!autoRetryAvailable) {
    return [SANDBOX_ALLOW_ADAPT_OPTION, SANDBOX_DENY_OPTION];
  }

  return [SANDBOX_ALLOW_RETRY_OPTION, SANDBOX_ALLOW_ADAPT_OPTION, SANDBOX_DENY_OPTION];
}

export function parseViolationPromptSelection(
  selection: string | undefined,
  autoRetryAvailable: boolean,
): ViolationResolutionKind {
  if (selection === SANDBOX_ALLOW_ADAPT_OPTION) return "allow-adapt";
  if (selection === SANDBOX_ALLOW_RETRY_OPTION && autoRetryAvailable) return "allow-retry";
  return "deny";
}

export function formatSandboxPermissionPromptTitle(
  details: SandboxPermissionPromptDetails,
): string {
  return formatSandboxPermissionLines(details).join("\n");
}

export function formatSandboxPermissionConfirmMessage(
  details: SandboxPermissionPromptDetails,
  question = "Allow for this session?",
): string {
  return [...formatSandboxPermissionLines(details, { includeTitle: false }), "", question].join(
    "\n",
  );
}

function renderSandboxPermissionPanel(
  details: SandboxPermissionPromptDetails,
  terminalWidth: number,
  theme: SandboxPromptTheme,
): string[] {
  const width = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, terminalWidth));
  const innerWidth = width - 2;
  const lines = [
    topBorder(width, theme),
    renderHeaderLine(details, width, theme),
    separator(width, theme),
  ];

  lines.push(
    ...renderField({
      label: details.targetLabel?.toLowerCase() ?? "target",
      value: details.target,
      color: "accent",
      width,
      theme,
      maxLines: 3,
    }),
  );
  lines.push(
    ...renderField({
      label: "process",
      value: details.requester,
      color: "success",
      width,
      theme,
      maxLines: 1,
    }),
  );
  lines.push(
    ...renderField({
      label: "command",
      value: details.command,
      color: "text",
      width,
      theme,
      maxLines: 3,
      spacerBefore: Boolean(details.requester),
    }),
  );
  lines.push(
    ...renderField({
      label: "session",
      value: details.sandboxChange,
      color: "warning",
      width,
      theme,
      maxLines: 2,
      spacerBefore: Boolean(details.target || details.requester || details.command),
    }),
  );
  lines.push(
    ...renderField({
      label: "note",
      value: details.extra,
      color: "muted",
      width,
      theme,
      maxLines: 2,
    }),
  );

  const scope = details.scope ?? DEFAULT_PROMPT_SCOPE;
  lines.push(
    panelLine(theme.fg("dim", `  ${truncateToWidth(scope, innerWidth - 2)}`), width, theme),
  );
  lines.push(bottomBorder(width, theme));

  return lines;
}

function renderHeaderLine(
  details: SandboxPermissionPromptDetails,
  width: number,
  theme: SandboxPromptTheme,
): string {
  const innerWidth = width - 2;
  const left = `${theme.fg("warning", theme.bold(" ⚠  SANDBOX BLOCKED"))}${theme.fg("dim", " · ")}${theme.fg("text", details.request)}`;
  const right = theme.fg("dim", details.typeCode ?? inferTypeCode(details));
  const spaces = Math.max(1, innerWidth - visibleWidth(left) - visibleWidth(right));
  return panelLine(`${left}${" ".repeat(spaces)}${right}`, width, theme);
}

function renderField(options: {
  label: string;
  value: string | undefined;
  color: "accent" | "success" | "warning" | "text" | "muted";
  width: number;
  theme: SandboxPromptTheme;
  maxLines: number;
  spacerBefore?: boolean;
}): string[] {
  const { label, value, color, width, theme, maxLines, spacerBefore = false } = options;
  if (!value) return [];

  const innerWidth = width - 2;
  const valueWidth = Math.max(12, innerWidth - LABEL_WIDTH - 4);
  const valueLines = wrapPlainText(truncatePromptValue(value), valueWidth, maxLines);
  const rows = spacerBefore ? [panelLine("", width, theme)] : [];
  const labelText = theme.fg("dim", `  ${label.padEnd(LABEL_WIDTH)}`);

  valueLines.forEach((line, index) => {
    const labelCell = index === 0 ? labelText : " ".repeat(LABEL_WIDTH + 2);
    rows.push(panelLine(`${labelCell}${theme.fg(color, line)}`, width, theme));
  });

  return rows;
}

function topBorder(width: number, theme: SandboxPromptTheme): string {
  return theme.fg("warning", `╭${"─".repeat(width - 2)}╮`);
}

function separator(width: number, theme: SandboxPromptTheme): string {
  return theme.fg("warning", `├${"─".repeat(width - 2)}┤`);
}

function bottomBorder(width: number, theme: SandboxPromptTheme): string {
  return theme.fg("warning", `╰${"─".repeat(width - 2)}╯`);
}

function panelLine(content: string, width: number, theme: SandboxPromptTheme): string {
  return `${theme.fg("warning", "│")}${truncateToWidth(content, width - 2, "…", true)}${theme.fg("warning", "│")}`;
}

function formatSandboxPermissionLines(
  details: SandboxPermissionPromptDetails,
  options: { includeTitle?: boolean } = {},
): string[] {
  const includeTitle = options.includeTitle ?? true;
  const lines: string[] = [];

  if (includeTitle) {
    lines.push(`⛔  ${details.title}`);
  }

  lines.push(details.request);

  if (details.target) {
    lines.push(
      "",
      `${details.targetLabel ?? "Target"}:`,
      `  ${truncatePromptValue(details.target)}`,
    );
  }

  if (details.sandboxChange) {
    lines.push("", "Allowing this will:", `  ${truncatePromptValue(details.sandboxChange)}`);
  }

  const trigger = formatPromptTrigger(details);
  if (trigger) lines.push("", trigger);

  lines.push("", `Scope: ${details.scope ?? DEFAULT_PROMPT_SCOPE}`);
  pushPromptLine(lines, "Note", details.extra);

  return lines;
}

function formatPromptTrigger(details: SandboxPermissionPromptDetails): string | undefined {
  const value = formatPromptTriggerValue(details);
  return value ? `Triggered by: ${value}` : undefined;
}

function formatPromptTriggerValue(details: SandboxPermissionPromptDetails): string | undefined {
  const requester = details.requester ? truncatePromptValue(details.requester) : undefined;
  const command = details.command ? truncatePromptValue(details.command) : undefined;

  if (requester && command) return `${requester} via ${command}`;
  if (requester) return requester;
  if (command) return command;
  return undefined;
}

function pushPromptLine(lines: string[], label: string, value: string | undefined): void {
  if (!value) return;
  lines.push(`${label}: ${truncatePromptValue(value)}`);
}

function truncatePromptValue(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= PROMPT_VALUE_LIMIT) return oneLine;
  return `${oneLine.slice(0, PROMPT_VALUE_LIMIT - 1)}…`;
}

function wrapPlainText(value: string, width: number, maxLines: number): string[] {
  const lines: string[] = [];
  let current = "";

  for (const char of value) {
    if (visibleWidth(current + char) <= width) {
      current += char;
      continue;
    }

    lines.push(current);
    current = char;
    if (lines.length === maxLines) break;
  }

  if (lines.length < maxLines && current) lines.push(current);
  if (lines.length === 0) return [""];
  if (visibleWidth(value) > width * maxLines) {
    lines[lines.length - 1] = truncateToWidth(lines[lines.length - 1] ?? "", width, "…");
  }
  return lines;
}

function inferTypeCode(details: SandboxPermissionPromptDetails): string {
  const request = details.request.toLowerCase();
  if (request.includes("network")) return "NET_OUT";
  if (request.includes("mach")) return "MACH_LU";
  if (request.includes("write")) return "FS_WRITE";
  if (request.includes("metadata")) return "FS_META";
  if (request.includes("read")) return "FS_READ";
  return "SANDBOX";
}
