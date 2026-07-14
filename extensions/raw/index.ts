import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

import { formatRawScrollback, rawTranscript } from "./render.js";

const CAPTURE_WIDGET_KEY = "raw-output-capture";

type RawTui = Pick<TUI, "start" | "stop" | "requestRender" | "terminal"> & Record<string, unknown>;

function emptyComponent(): Component {
  return {
    render: () => [],
    invalidate: () => {},
  };
}

function waitForEnter(): Promise<void> {
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;

  if (!wasRaw) stdin.setRawMode?.(true);

  return new Promise((resolve) => {
    const onData = (): void => {
      if (!wasRaw) stdin.setRawMode?.(false);
      stdin.pause();
      resolve();
    };

    stdin.once("data", onData);
    stdin.resume();
  });
}

/**
 * Resume at the end of the raw dump without clearing it from scrollback.
 * TUI's public forced redraw clears scrollback, so reset its render bookkeeping
 * to the same values it has before its initial non-clearing render instead.
 */
function resetTuiForScrollback(tui: RawTui): void {
  tui.previousLines = [];
  tui.previousKittyImageIds = new Set<number>();
  tui.previousWidth = 0;
  tui.previousHeight = 0;
  tui.cursorRow = 0;
  tui.hardwareCursorRow = 0;
  tui.maxLinesRendered = 0;
  tui.previousViewportTop = 0;
  // stop() cancels the pending timer but leaves this flag set, which makes
  // start() skip scheduling the redraw needed to restore Pi's UI.
  tui.renderRequested = false;
  tui.renderTimer = undefined;
}

function isInteractiveTui(ctx: ExtensionContext): boolean {
  const mode = (ctx as { mode?: unknown }).mode;
  return mode === undefined ? ctx.hasUI : mode === "tui";
}

function reportUnavailable(ctx: ExtensionContext, message: string): void {
  ctx.ui.notify(message, "warning");
}

export default function rawOutputExtension(pi: ExtensionAPI): void {
  let tui: RawTui | undefined;
  let rawViewOpen = false;

  const showRawTranscript = async (ctx: ExtensionContext): Promise<void> => {
    if (!isInteractiveTui(ctx)) {
      reportUnavailable(ctx, "/raw is available in Pi's interactive terminal mode.");
      return;
    }

    if (!ctx.isIdle()) {
      reportUnavailable(ctx, "Wait for the current response to finish before opening /raw.");
      return;
    }

    const currentTui = tui;
    if (!currentTui) {
      reportUnavailable(ctx, "Raw view is not ready. Run /reload and try again.");
      return;
    }

    if (rawViewOpen) return;

    rawViewOpen = true;
    let stopped = false;
    try {
      const transcript = rawTranscript(ctx.sessionManager.getBranch());
      currentTui.stop();
      stopped = true;
      currentTui.terminal.write(formatRawScrollback(transcript));
      await waitForEnter();
    } finally {
      rawViewOpen = false;
      if (stopped) {
        resetTuiForScrollback(currentTui);
        currentTui.start();
      }
    }
  };

  pi.registerCommand("raw", {
    description: "Open an unwrapped, copy-friendly transcript in terminal scrollback",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /raw", "error");
        return;
      }

      await showRawTranscript(ctx);
    },
  });

  pi.registerShortcut("alt+r" as never, {
    description: "Open an unwrapped, copy-friendly transcript in terminal scrollback",
    handler: async (ctx) => {
      await showRawTranscript(ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (!isInteractiveTui(ctx)) return;

    ctx.ui.setWidget(
      CAPTURE_WIDGET_KEY,
      (currentTui) => {
        tui = currentTui as unknown as RawTui;
        return emptyComponent();
      },
      { placement: "belowEditor" },
    );
  });

  pi.on("session_shutdown", (_event, ctx) => {
    tui = undefined;
    rawViewOpen = false;
    if (isInteractiveTui(ctx)) {
      ctx.ui.setWidget(CAPTURE_WIDGET_KEY, undefined);
    }
  });
}
