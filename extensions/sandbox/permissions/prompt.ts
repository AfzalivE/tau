import { keyHint, rawKeyHint, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  SelectList,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export interface SandboxPermissionPrompt {
  request: string;
  target: string;
  targetLabel?: string;
  requester?: string;
  command?: string;
  typeCode: string;
}

/** Keep the fork's compact panel in the editor dock; RPC clients own their presentation. */
export async function showSandboxPermissionSelect(
  ctx: ExtensionContext,
  prompt: SandboxPermissionPrompt,
  options: string[],
): Promise<string | undefined> {
  if (!ctx.hasUI) return undefined;
  if (ctx.mode !== "tui") {
    return ctx.ui.select(
      [
        `Sandbox blocked ${plain(prompt.request).toLowerCase()}: ${plain(prompt.target)}`,
        ...(prompt.requester ? [`Process: ${plain(prompt.requester)}`] : []),
        ...(prompt.command ? [`Command: ${plain(prompt.command)}`] : []),
      ].join("\n"),
      options,
    );
  }

  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    let renderedWidth = 0;
    const list = new SelectList(
      options.map((option) => ({ value: option, label: option })),
      options.length,
      {
        selectedPrefix: (text) => theme.fg("warning", text),
        selectedText: (text) => theme.fg("warning", theme.bold(text)),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      },
    );
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(undefined);
    const component = {
      focused: false,
      render(width: number): string[] {
        renderedWidth = width;
        const panelWidth = Math.min(96, width);
        if (panelWidth < 4) return [truncateToWidth("Resize to review. Escape cancels.", width)];
        const innerWidth = panelWidth - 2;
        const border = (left: string, right: string) =>
          theme.fg("warning", `${left}${"─".repeat(innerWidth)}${right}`);
        const row = (content: string) =>
          `${theme.fg("warning", "│")}${truncateToWidth(content, innerWidth, "…", true)}${theme.fg("warning", "│")}`;
        const request = theme.fg("text", plain(prompt.request));
        const heading = `${theme.fg("warning", theme.bold(" SANDBOX BLOCKED"))}${theme.fg("dim", " · ")}${request}`;
        const code = theme.fg("dim", plain(prompt.typeCode));
        const lines = [
          border("╭", "╮"),
          row(
            `${heading}${" ".repeat(Math.max(1, innerWidth - visibleWidth(heading) - visibleWidth(code)))}${code}`,
          ),
          border("├", "┤"),
        ];
        const field = (
          label: string,
          value: string | undefined,
          color: "accent" | "success" | "text",
          maxLines: number,
        ) => {
          if (!value) return;
          const labelWidth = Math.min(9, Math.max(0, innerWidth - 14));
          const indent = Math.min(2, Math.max(0, innerWidth - 1));
          const valueWidth = Math.max(1, innerWidth - labelWidth - indent);
          const wrapped = wrapTextWithAnsi(plain(value), valueWidth);
          for (const [index, line] of wrapped.slice(0, maxLines).entries()) {
            const prefix =
              index === 0 ? label.padEnd(labelWidth).slice(0, labelWidth) : " ".repeat(labelWidth);
            const text =
              index === maxLines - 1 && wrapped.length > maxLines
                ? truncateToWidth(`${line}…`, valueWidth)
                : line;
            lines.push(
              row(`${" ".repeat(indent)}${theme.fg("dim", prefix)}${theme.fg(color, text)}`),
            );
          }
        };
        field(plain(prompt.targetLabel ?? "target"), prompt.target, "accent", 3);
        field("process", prompt.requester, "success", 1);
        field("command", prompt.command, "text", 3);
        lines.push(border("╰", "╯"), "");
        const selected = list.getSelectedItem()?.value;
        for (const [index, line] of list.render(panelWidth).entries()) {
          lines.push(`${this.focused && options[index] === selected ? CURSOR_MARKER : ""}${line}`);
        }
        lines.push(
          truncateToWidth(
            theme.fg(
              "dim",
              `  ${rawKeyHint("↑↓", "navigate")}  ${keyHint("tui.select.confirm", "select")}  ${keyHint("tui.select.cancel", "cancel")}`,
            ),
            width,
          ),
        );
        return lines;
      },
      invalidate: () => list.invalidate(),
      handleInput(data: string) {
        const selected = list.getSelectedItem()?.value ?? "";
        if (
          keybindings.matches(data, "tui.select.confirm") &&
          Math.min(renderedWidth, tui.terminal.columns) < visibleWidth(` → ${selected} `)
        )
          return;
        list.handleInput(data);
        tui.requestRender();
      },
    };
    return component;
  });
}

/** Render paths and command text as data, including terminal and bidi control characters. */
function plain(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) =>
    character
      .split("")
      .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join(""),
  );
}
