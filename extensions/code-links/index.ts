import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, getCapabilities, type TUI } from "@earendil-works/pi-tui";
import { CodeIndex, linkReferences, type Location } from "./code-index.js";

const editors = {
  zed: ({ path: file, line, column }: Location) =>
    `zed://file${encodeURI(file)}${position(line, column)}`,
  vscode: ({ path: file, line, column }: Location) =>
    `vscode://file${encodeURI(file)}${position(line, column)}`,
  cursor: ({ path: file, line, column }: Location) =>
    `cursor://file${encodeURI(file)}${position(line, column)}`,
  // JetBrains IDEs, including Android Studio, register the idea scheme.
  studio: ({ path: file, line, column }: Location) =>
    `idea://open?file=${encodeURIComponent(file)}${query("line", line)}${query("column", column)}`,
  file: ({ path: file }: Location) => `file://${encodeURI(file)}`,
};

type Editor = keyof typeof editors;

const WIDGET_KEY = "code-links";
const CONFIG_FILE = "code-links.json";
const DEFAULT_EDITOR: Editor = "zed";
const EDITORS = Object.keys(editors) as Editor[];

/** Link file paths and code symbols in the transcript to an editor. Only rendered text changes. */
export default function codeLinks(pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let index: CodeIndex | undefined;
  let editor = DEFAULT_EDITOR;

  // The config and index load asynchronously. A result that arrives after shutdown belongs
  // to a stale ctx, so it is dropped.
  pi.on("session_start", (_event, nextCtx) => {
    ctx = undefined;
    index = undefined;
    if (nextCtx.mode !== "tui") return;
    ctx = nextCtx;
    void loadEditor().then((saved) => {
      if (ctx !== nextCtx || saved === editor) return;
      editor = saved;
      if (index) redraw(nextCtx);
    });
    const next = new CodeIndex(nextCtx.cwd);
    next.build().then(
      () => {
        if (ctx !== nextCtx) return;
        index = next;
        redraw(nextCtx);
      },
      (error: Error) => {
        if (ctx === nextCtx) nextCtx.ui.notify(`code-links: ${error.message}`, "warning");
      },
    );
  });

  pi.on("session_shutdown", () => {
    ctx = undefined;
    index = undefined;
  });

  pi.on("tool_result", (event) => {
    const file = event.input.path;
    const current = ctx;
    const currentIndex = index;
    if (!current || !currentIndex || typeof file !== "string") return;
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    currentIndex.refresh(file).then(
      () => {
        if (ctx === current) redraw(current);
      },
      () => {},
    );
  });

  pi.registerCommand("code-links", {
    description: "Choose the editor that code links open",
    getArgumentCompletions: (prefix) =>
      EDITORS.filter((name) => name.startsWith(prefix.trim())).map((name) => ({
        value: name,
        label: name,
      })),
    handler: async (args, commandCtx) => {
      const chosen =
        args.trim() ||
        (await commandCtx.ui.select(`Code links open in (current: ${editor})`, EDITORS));
      if (!chosen) return;
      if (!isEditor(chosen)) {
        commandCtx.ui.notify(
          `Unknown editor "${chosen}". Use one of: ${EDITORS.join(", ")}`,
          "error",
        );
        return;
      }
      editor = chosen;
      await saveEditor(chosen);
      redraw(commandCtx);
      commandCtx.ui.notify(`Code links open in ${chosen}`, "info");
    },
  });

  pi.registerMarkdownTransformer((markdown, context) => {
    if (!index || context.isStreaming || !getCapabilities().hyperlinks) return markdown;
    return linkReferences(markdown, index, editors[editor]);
  });
}

// Messages cache their rendered lines, so messages drawn before a link change need a redraw.
// A widget factory is the only extension access to the TUI; Pi calls it synchronously.
function redraw(ctx: ExtensionContext) {
  let tui: TUI | undefined;
  ctx.ui.setWidget(WIDGET_KEY, (instance) => {
    tui = instance;
    return new Container();
  });
  ctx.ui.setWidget(WIDGET_KEY, undefined);
  tui?.invalidate();
  tui?.requestRender();
}

async function loadEditor(): Promise<Editor> {
  try {
    const config = JSON.parse(await readFile(configPath(), "utf8"));
    return isEditor(config?.editor) ? config.editor : DEFAULT_EDITOR;
  } catch {
    return DEFAULT_EDITOR;
  }
}

async function saveEditor(editor: Editor) {
  await mkdir(path.dirname(configPath()), { recursive: true });
  await writeFile(configPath(), `${JSON.stringify({ editor }, null, 2)}\n`, "utf8");
}

function configPath() {
  return path.join(getAgentDir(), CONFIG_FILE);
}

function isEditor(value: unknown): value is Editor {
  return typeof value === "string" && (EDITORS as string[]).includes(value);
}

function position(line: number | undefined, column: number | undefined) {
  if (!line) return "";
  return column ? `:${line}:${column}` : `:${line}`;
}

function query(name: string, value: number | undefined) {
  return value ? `&${name}=${value}` : "";
}
