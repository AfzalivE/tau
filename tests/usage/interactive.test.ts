/* oxlint-disable no-control-regex -- ANSI sequences are the rendering contract under test. */
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  getAgentDir,
  SessionManager,
  Theme,
  type ExtensionFactory,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  colorToOkhsl,
  indexedColor,
  resetCapabilitiesCache,
  rgbColor,
  type Color,
} from "@earendil-works/pi-tui";
import { deadline } from "../helpers/async.js";
import {
  captureTerminal,
  observeInteractive,
  openInteractive,
  rejectInteractiveExternalWork,
} from "../helpers/interactive.js";
import { assistantMessage, createPiResources, fixtureModel, isolatePiHome } from "../helpers/pi.js";
import { scriptedProvider } from "../helpers/provider.js";

const now = new Date("2026-06-15T12:00:00Z");
const quotaUrl = "https://api.anthropic.com/api/oauth/usage";
const lastRow = /reef-small\s+100\s+\$1\.00\s+33%/;

describe("usage InteractiveMode", { concurrency: false }, () => {
  let home: Awaited<ReturnType<typeof isolatePiHome>>;
  let usage: ExtensionFactory;
  let app: Awaited<ReturnType<typeof openInteractive>> | undefined;
  let failures: unknown[];
  let quota: Promise<Response>;
  let publishQuota: (response: Response) => void;
  let quotaRequests: number;
  let previousTrueColor: string | undefined;

  before(async () => {
    home = await isolatePiHome();
    usage = (await import("../../extensions/usage/index.js")).default;
  });

  after(async () => home.dispose());

  beforeEach(() => {
    previousTrueColor = process.env.PI_TRUE_COLOR;
    process.env.PI_TRUE_COLOR = "1";
    resetCapabilitiesCache();
    quotaRequests = 0;
    failures = [];
    rejectInteractiveExternalWork(failures);
    mock.timers.enable({ apis: ["Date"], now });
    quota = new Promise<Response>((resolve) => {
      publishQuota = resolve;
    });
    mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      try {
        assert.equal(request.url, quotaUrl);
        assert.equal(request.method, "GET");
        assert.equal(request.headers.get("authorization"), "Bearer fixture-anthropic");
      } catch (error) {
        failures.push(error);
        throw error;
      }
      quotaRequests += 1;
      return quota;
    });
  });

  afterEach(async () => {
    try {
      await app?.dispose();
      assert.deepEqual(failures, [], "unexpected external work and extension errors");
    } finally {
      app = undefined;
      mock.restoreAll();
      mock.timers.reset();
      syncBuiltinESMExports();
      if (previousTrueColor === undefined) delete process.env.PI_TRUE_COLOR;
      else process.env.PI_TRUE_COLOR = previousTrueColor;
      resetCapabilitiesCache();
      await rm(path.join(getAgentDir(), "sessions"), { recursive: true, force: true });
      await rm(path.join(getAgentDir(), "auth.json"), { force: true });
      await rm(path.join(getAgentDir(), "keybindings.json"), { force: true });
    }
  });

  for (const mode of ["regular", "default"] as const) {
    test(`${mode}: bounded quota/history overlay preserves a tall transcript and draft`, async () => {
      const terminal = captureTerminal(80, 24);
      const observer = observeInteractive();
      const resources = await usageResources(usage, observer.extension, failures);
      if (mode === "default") {
        await writeFile(
          path.join(getAgentDir(), "keybindings.json"),
          JSON.stringify({
            "tui.altScreen.pageDown": "ctrl+d",
            "tui.altScreen.lineDown": "j",
          }),
        );
      }
      app = await openInteractive(resources, failures, mode);
      const { ctx, tui } = observer.get();
      assert.equal(tui.mode, mode === "default" ? "fullscreen" : "regular");
      const draft = "ink\nkeep my 🦑 draft exactly  ";
      ctx.ui.setEditorText(draft);
      const history = structuredClone(resources.sessionManager.getEntries());
      const messages = structuredClone(app.session.messages);
      const command = app.session.prompt("/usage", { source: "interactive" });
      const repaint = () => terminal.repaint(tui);
      try {
        await terminal.waitForText("Usage  [all]");
        terminal.send("]");
        await terminal.waitForText("Usage loading");
        terminal.send("\x1b[1;5F");
        const beforeQuota = repaint();
        assert.match(beforeQuota, lastRow);
        const offset = /q close · (\d+)–/.exec(beforeQuota)?.[1];
        assert.ok(offset && Number(offset) > 1, "scroll before live publication");
        for (const appearance of ["light", "dark"] as const) {
          assert.equal(ctx.ui.setTheme(appearance).success, true);
          const themed = repaint();
          assert.equal(/q close · (\d+)–/.exec(themed)?.[1], offset);
          assert.match(themed, lastRow, "theme changes preserve the cached reading position");
          assertThemedText(terminal.writes, "reef-small", ctx.ui.theme, "text");
          assert.equal(ctx.ui.getEditorText(), draft);
          assert.deepEqual(resources.sessionManager.getEntries(), history);
          assert.deepEqual(app.session.messages, messages);
          assert.equal(quotaRequests, 1, "theme changes do not restart pending quota requests");
        }
        publishQuota(quotaResponse());
        await terminal.waitForText("Extra usage:");
        assert.equal(
          /q close · (\d+)–/.exec(repaint())?.[1],
          offset,
          "live publication preserves the offset, not the old bottom",
        );
        terminal.send("\x1b[1;5H");
        const initial = repaint();
        assert.match(initial, /Session \(5h\): 11% used/);
        assert.match(initial, /q close/);
        assert.doesNotMatch(
          initial,
          lastRow,
          "both modes now show a bounded viewport, not full emission",
        );
        if (mode === "default") {
          assert.match(initial, /pageUp\/ctrl\+d scroll/, "reading hints reflect configured keys");
          terminal.send("\x1b[6~");
          assert.doesNotMatch(repaint(), lastRow, "replaced PageDown binding no longer scrolls");
          terminal.send("j");
          assert.match(
            repaint(),
            /q close · 2–/,
            "configured line scrolling precedes the view alias",
          );
          assert.match(repaint(), /\[model\]/);
        }
        terminal.send(mode === "default" ? "\x04" : "\x1b[6~");
        assert.match(
          repaint(),
          lastRow,
          "configured page action reads Usage rather than the parent transcript",
        );
        terminal.send("\x1b[1;5H");
        assert.match(repaint(), /Session \(5h\): 11% used/);
        terminal.send("\x1b[1;5F");
        assert.match(repaint(), lastRow);
        terminal.send("\x1b[5~");
        assert.match(repaint(), /Session \(5h\): 11% used/);
        terminal.send("\x1b[1;5F");
        for (const [columns, rows] of [
          [120, 30],
          [120, 16],
          [120, 30],
          [48, 18],
        ]) {
          terminal.resize(columns!, rows!);
          const resized = repaint();
          assert.match(resized, /q close/);
          terminal.send("\x1b[1;5F");
          assert.match(
            repaint(),
            lastRow,
            `last table row reachable after ${columns}×${rows} resize`,
          );
          terminal.send("\x1b[1;5H");
          assert.match(repaint(), /Session \(5h\): 11% used/);
        }
        terminal.resize(80, 24);
        repaint();
        terminal.send("\x1b[1;5F");
        assert.match(repaint(), lastRow);
        terminal.resize(26, 6); // Four chrome rows leave no document row.
        assert.match(repaint(), /q close · resize/);
        terminal.send("\x1b[1;5H"); // Hidden Ctrl+Home and view controls cannot move the document.
        terminal.send("j");
        terminal.resize(25, 7); // One column below the supported document width.
        assert.match(repaint(), /q close · resize/);
        terminal.resize(80, 24);
        assert.match(repaint(), lastRow, "tiny-size fallback preserves the reading position");
        if (mode === "default") {
          terminal.send("\x1b[102;6u"); // Native Ctrl+Shift+F transcript search.
          assert.match(repaint(), /Find in transcript/);
          terminal.send("peaceful");
          assert.match(repaint(), /\d+\/80/, "native search owns the parent transcript, not Usage");
          terminal.send("\x1b");
          assert.match(
            repaint(),
            lastRow,
            "closing native search restores Usage, not its parent editor",
          );
          terminal.send("\x1b[1;5H");
          assert.match(repaint(), /Session \(5h\): 11% used/);
          terminal.send("\x1b[1;5F");
        }
        terminal.send("\x1b[B");
        assert.match(repaint(), /\[cwd\]/);
        assert.match(
          repaint(),
          /Session \(5h\): 11% used/,
          "view navigation resets reading position",
        );
        terminal.send("\x1b[A");
        assert.match(repaint(), /\[model\]/);
        terminal.send("\t");
        assert.match(repaint(), /\[sess\]/);
        terminal.send("\x1b[C");
        assert.match(repaint(), /\[90d\]/);
        terminal.resize(26, 6);
        assert.match(repaint(), /q close · resize/);
      } finally {
        publishQuota(quotaResponse());
        terminal.send("q");
        await deadline(command, "Usage command completion");
      }
      assert.equal(ctx.ui.getEditorText(), draft);
      assert.deepEqual(resources.sessionManager.getEntries(), history);
      assert.deepEqual(app.session.messages, messages);
      assert.equal(app.session.pendingMessageCount, 0);
      terminal.resize(80, 24);
      assert.match(repaint(), /keep my 🦑 draft exactly/);
      terminal.send("!");
      assert.equal(ctx.ui.getEditorText(), `${draft}!`, "closing restores native editor focus");
    });
  }

  test("256-color: native light/dark themes recolor charts and quota bars on a themed surface", async () => {
    process.env.PI_TRUE_COLOR = "0";
    resetCapabilitiesCache();
    const terminal = captureTerminal(100, 50);
    const observer = observeInteractive();
    const resources = await usageResources(usage, observer.extension, failures);
    // A tiny occupied day must still be stronger than the surrounding empty days.
    mock.timers.setTime(now.getTime() - 7 * 86_400_000);
    const sparseHistory = SessionManager.create(
      resources.cwd,
      path.join(getAgentDir(), "sessions", "reef"),
    );
    const sparseMessage = assistantMessage("One shy reef token.");
    sparseMessage.provider = "anthropic";
    sparseMessage.model = "reef-big";
    sparseMessage.timestamp = Date.now();
    sparseMessage.usage.input = sparseMessage.usage.totalTokens = 1;
    sparseHistory.appendMessage(sparseMessage);
    mock.timers.setTime(now.getTime());
    app = await openInteractive(resources, failures);
    const { ctx, tui } = observer.get();
    const command = app.session.prompt("/usage", { source: "interactive" });
    const filledLightness: number[] = [];
    const emptyLightness: number[] = [];
    try {
      await terminal.waitForText("Usage  [all]");
      for (const appearance of ["dark", "light"] as const) {
        assert.equal(ctx.ui.setTheme(appearance).success, true);
        assert.equal(ctx.ui.theme.appearance, appearance);
        assert.equal(ctx.ui.theme.getColorMode(), "256color");
        terminal.repaint(tui);
        assertThemedText(terminal.writes, "[30d]", ctx.ui.theme, "text");
        assertThemedText(terminal.writes, "Last 30 days:", ctx.ui.theme, "text");
        assertThemedText(terminal.writes, "anthropic/reef-big", ctx.ui.theme, "text");
        const legend = rawLine(terminal.writes, "█ anthropic/reef-big");
        const category = colorsAt(legend, "█ anthropic/reef-big").fg;
        const semanticColors = Object.values(ctx.ui.theme.colors).map(
          (fg) => colorsAt(ctx.ui.theme.style("█", { fg }), "█").fg,
        );
        assert.ok(
          semanticColors.some((fg) => JSON.stringify(fg) === JSON.stringify(category)),
          "generic legend categories use semantic theme colors",
        );
        const emptyCell = colorsAt(rawLine(terminal.writes, "Wed"), "█");
        assert.deepEqual(
          emptyCell.bg,
          colorsAt(ctx.ui.theme.style("█", { bg: "toolPendingBg" }), "█").bg,
          "empty history cells retain the active panel background",
        );
        assert.ok(emptyCell.fg);
        assert.notDeepEqual(emptyCell.fg, emptyCell.bg, "empty cells remain visible on the panel");
        const mondayCells = coloredCharacters(rawLine(terminal.writes, "Mon")).filter(
          (cell) => cell.text === "█",
        );
        const occupiedHistoryCell = mondayCells.at(-1)!;
        assert.deepEqual(occupiedHistoryCell.bg, emptyCell.bg);
        assert.notDeepEqual(
          occupiedHistoryCell.fg,
          emptyCell.fg,
          "occupied history cells are visible",
        );
        assert.ok(emptyCell.fg && emptyCell.bg);
        const surfaceL = colorToOkhsl(emptyCell.bg).l;
        const emptyDistance = Math.abs(colorToOkhsl(emptyCell.fg).l - surfaceL);
        const signals = mondayCells.filter(
          (cell) => JSON.stringify(cell.fg) !== JSON.stringify(emptyCell.fg),
        );
        assert.equal(
          new Set(signals.map((cell) => JSON.stringify(cell.fg))).size,
          2,
          "sparse and busy days remain distinct from empty cells and each other",
        );
        for (const cell of signals) {
          assert.ok(cell.fg);
          assert.ok(
            Math.abs(colorToOkhsl(cell.fg).l - surfaceL) > emptyDistance,
            "even sparse activity is stronger than empty cells",
          );
        }
        assert.doesNotMatch(terminal.writes.join(""), /\x1b\[(?:38|48);2;/);
        terminal.send("\x1b[B");
        terminal.send("\x1b[B");
        terminal.repaint(tui);
        assertThemedText(terminal.writes, "100%", ctx.ui.theme, "text");
        terminal.send("\x1b[A");
        terminal.send("\x1b[A");
        terminal.send("]");
        if (appearance === "dark") {
          await terminal.waitForText("Usage loading");
          publishQuota(quotaResponse());
          await terminal.waitForText("Extra usage:");
        }
        terminal.repaint(tui);
        assertThemedText(terminal.writes, "Session (5h):", ctx.ui.theme, "text");
        const modelColors = ["reef-big", "reef-small"].map(
          (model) => colorsAt(rawLine(terminal.writes, `█ ${model}`), `█ ${model}`).fg,
        );
        assert.notDeepEqual(
          modelColors[0],
          modelColors[1],
          "provider model variants survive 256-color quantization",
        );
        const lines = rawLines(terminal.writes);
        const label = lines.findIndex((line) =>
          stripVTControlCharacters(line).includes("Session (5h):"),
        );
        assert.ok(label >= 0);
        const bar = coloredCharacters(lines[label + 1]!).filter((cell) => cell.text === "█");
        assert.ok(bar.length >= 10, "quota bar is visible");
        const filled = bar[0]!;
        const empty = bar.at(-1)!;
        const panel = emptyCell.bg;
        assert.ok(filled.fg && empty.fg && panel);
        for (const cell of bar)
          assert.deepEqual(cell.bg, panel, "quota bars retain panel background");
        assert.deepEqual(
          { fg: empty.fg, bg: empty.bg },
          emptyCell,
          "empty quota and history cells agree",
        );
        assert.notDeepEqual(filled.fg, empty.fg, "used quota is distinct from the empty track");
        const panelLightness = colorToOkhsl(panel).l;
        const emptyL = colorToOkhsl(empty.fg).l;
        assert.ok(
          appearance === "dark" ? emptyL > panelLightness : emptyL < panelLightness,
          "empty cells contrast in the active appearance's direction",
        );
        const providerColor = colorToOkhsl(filled.fg);
        const accent = colorToOkhsl(ctx.ui.theme.colors.accent);
        assert.notDeepEqual(
          filled.fg,
          colorsAt(ctx.ui.theme.style("█", { fg: "accent" }), "█").fg,
          "provider identity keeps its own hue instead of becoming the generic accent",
        );
        assert.ok(
          Math.abs(providerColor.l - accent.l) < 0.08,
          "provider lightness follows the theme accent",
        );
        assert.ok(
          providerColor.s <= accent.s + 0.15,
          "provider saturation respects the accent after palette quantization",
        );
        filledLightness.push(providerColor.l);
        emptyLightness.push(emptyL);
        assert.doesNotMatch(terminal.writes.join(""), /\x1b\[(?:38|48);2;/);
        assert.match(
          terminal.writes.join(""),
          /\x1b\[38;5;/,
          "native palette-index foreground output",
        );
        assert.equal(quotaRequests, 1, "theme changes reuse completed quota data");
        terminal.send("[");
      }
      assert.ok(
        filledLightness[0]! > filledLightness[1]!,
        "provider hues darken for a light theme",
      );
      assert.ok(
        emptyLightness[0]! < emptyLightness[1]!,
        "empty tracks follow the panel appearance",
      );
    } finally {
      publishQuota(quotaResponse());
      terminal.send("q");
      await deadline(command, "Usage command completion");
    }
  });

  test("indexed semantic colors and wide-label padding survive native rendering", async () => {
    process.env.PI_TRUE_COLOR = "0";
    resetCapabilitiesCache();
    const terminal = captureTerminal(100, 50);
    const observer = observeInteractive();
    const resources = await usageResources(usage, observer.extension, failures, "界".repeat(30));
    app = await openInteractive(resources, failures);
    const { ctx, tui } = observer.get();
    const backgroundTokens = new Set([
      "selectedBg",
      "searchMatchBg",
      "userMessageBg",
      "customMessageBg",
      "toolPendingBg",
      "toolSuccessBg",
      "toolErrorBg",
    ]);
    const foreground = Object.fromEntries(
      Object.keys(ctx.ui.theme.colors)
        .filter((token) => !backgroundTokens.has(token))
        .map((token) => [token, 2]),
    ) as ConstructorParameters<typeof Theme>[0];
    foreground.text = 15;
    foreground.muted = 8;
    const background = Object.fromEntries(
      [...backgroundTokens].map((token) => [token, 0]),
    ) as ConstructorParameters<typeof Theme>[1];
    assert.equal(
      ctx.ui.setTheme(new Theme(foreground, background, "256color", { appearance: "dark" }))
        .success,
      true,
    );
    const command = app.session.prompt("/usage", { source: "interactive" });
    try {
      await terminal.waitForText("Usage  [all]");
      terminal.repaint(tui);
      assert.deepEqual(
        colorsAt(rawLine(terminal.writes, "█ anthropic/界"), "█ anthropic/界").fg,
        indexedColor(2),
        "legend categories preserve the terminal's ANSI color identity",
      );
      assert.deepEqual(
        colorsAt(rawLine(terminal.writes, "█ other"), "█ other").fg,
        indexedColor(8),
      );
      terminal.send("\x1b[B");
      terminal.send("\x1b[B");
      terminal.repaint(tui);
      assert.deepEqual(
        colorsAt(rawLine(terminal.writes, "Mon"), "█").fg,
        indexedColor(2),
        "non-interpolated weekday bars preserve ANSI indices",
      );
      terminal.send("\x1b[A");
      terminal.send("\x1b[A");
      terminal.resize(55, 50); // With this fixture's six-week grid, the side legend gets 24 columns.
      terminal.repaint(tui);
      const wideLine = rawLine(terminal.writes, "█ anthropic/界");
      assert.match(
        stripVTControlCharacters(wideLine),
        /界.*\.\.\. /,
        "wide truncation leaves a padding cell after its ellipsis",
      );
      assert.deepEqual(
        colorsAt(wideLine, "... ", 3).bg,
        indexedColor(0),
        "padding after truncated wide text retains the panel background",
      );
      assert.equal(quotaRequests, 0);
    } finally {
      terminal.send("q");
      await deadline(command, "Usage command completion");
    }
  });

  for (const state of ["error", "unavailable"] as const) {
    test(`native themes recolor ${state} quota messages while the overlay stays open`, async () => {
      const terminal = captureTerminal(100, 32);
      const observer = observeInteractive();
      const resources = await usageResources(usage, observer.extension, failures);
      if (state === "unavailable") await rm(path.join(getAgentDir(), "auth.json"));
      app = await openInteractive(resources, failures);
      const { ctx, tui } = observer.get();
      const command = app.session.prompt("/usage", { source: "interactive" });
      const message = state === "error" ? "Usage unavailable" : "History only";
      try {
        await terminal.waitForText("Usage  [all]");
        terminal.send("]");
        if (state === "error") {
          await terminal.waitForText("Usage loading");
          publishQuota(
            Response.json({ error: { message: "The reef is resting." } }, { status: 503 }),
          );
        }
        await terminal.waitForText(message);
        for (const appearance of ["light", "dark"] as const) {
          assert.equal(ctx.ui.setTheme(appearance).success, true);
          assert.match(terminal.repaint(tui), new RegExp(message));
          assertThemedText(
            terminal.writes,
            message,
            ctx.ui.theme,
            state === "error" ? "error" : "muted",
          );
          assert.equal(quotaRequests, state === "error" ? 1 : 0);
        }
      } finally {
        publishQuota(quotaResponse());
        terminal.send("q");
        await deadline(command, "Usage command completion");
      }
    });
  }
});

function quotaResponse() {
  return Response.json({
    five_hour: { utilization: 11 },
    seven_day: { utilization: 22 },
    seven_day_sonnet: { utilization: 33 },
    extra_usage: {
      is_enabled: true,
      utilization: 44,
      monthly_limit: 10000,
      used_credits: 4400,
      currency: "USD",
    },
  });
}

function assertThemedText(writes: string[], text: string, theme: Theme, fg: ThemeColor) {
  assert.deepEqual(
    colorsAt(rawLine(writes, text), text),
    colorsAt(theme.style(text, { fg, bg: "toolPendingBg" }), text),
    `${text} uses active ${fg} and panel tokens`,
  );
}

/** Fullscreen frames position each row with CUP. Regular frames separate rows with newlines. */
function rawLines(writes: string[]): string[] {
  return writes.join("").split(/\n|\x1b\[\d+(?:;\d+)?H/);
}

function rawLine(writes: string[], text: string): string {
  const line = rawLines(writes).find((line) => stripVTControlCharacters(line).includes(text));
  assert.ok(line, `rendered line containing ${text}`);
  return line;
}

function colorsAt(raw: string, text: string, offset = 0) {
  const characters = coloredCharacters(raw);
  const index = characters
    .map((cell) => cell.text)
    .join("")
    .indexOf(text);
  assert.ok(index >= 0, `rendered text ${text}`);
  const { fg, bg } = characters[index + offset]!;
  return { fg, bg };
}

/** Read effective SGR foreground/background at characters, independent of reset/nesting layout. */
function coloredCharacters(raw: string) {
  let fg: Color | undefined;
  let bg: Color | undefined;
  const characters: Array<{ text: string; fg: Color | undefined; bg: Color | undefined }> = [];
  for (const part of raw.split(/(\x1b\[[\d;]*m)/)) {
    if (!/^\x1b\[[\d;]*m$/.test(part)) {
      for (const text of stripVTControlCharacters(part).split(""))
        characters.push({ text, fg, bg });
      continue;
    }
    const codes = part.slice(2, -1).split(";").map(Number);
    for (let index = 0; index < codes.length; index += 1) {
      const code = codes[index];
      if (code === 0) fg = bg = undefined;
      else if (code === 39) fg = undefined;
      else if (code === 49) bg = undefined;
      else if (code === 38 || code === 48) {
        const mode = codes[++index];
        let color: Color;
        if (mode === 5) color = indexedColor(codes[++index]!);
        else {
          assert.equal(mode, 2, "supported extended SGR color mode");
          color = rgbColor(codes[++index]!, codes[++index]!, codes[++index]!);
        }
        if (code === 38) fg = color;
        else bg = color;
      } else if (code !== undefined && code >= 30 && code <= 37) fg = indexedColor(code - 30);
      else if (code !== undefined && code >= 40 && code <= 47) bg = indexedColor(code - 40);
      else if (code !== undefined && code >= 90 && code <= 97) fg = indexedColor(code - 90 + 8);
      else if (code !== undefined && code >= 100 && code <= 107) bg = indexedColor(code - 100 + 8);
    }
  }
  return characters;
}

/** Real on-disk usage records, with an unrelated tall parent transcript kept strictly in memory. */
async function usageResources(
  usage: ExtensionFactory,
  observer: ExtensionFactory,
  failures: unknown[],
  firstModel = "reef-big",
) {
  const cwd = path.join(getAgentDir(), "reef");
  await mkdir(cwd, { recursive: true });
  const history = SessionManager.create(cwd, path.join(getAgentDir(), "sessions", "reef"));
  history.appendMessage({ role: "user", content: "Count reef tokens.", timestamp: now.getTime() });
  for (const [model, tokens, cost] of [
    [firstModel, 200, 2],
    ["reef-small", 100, 1],
  ] as const) {
    const message = assistantMessage("Counted.");
    message.provider = "anthropic";
    message.model = model;
    message.timestamp = now.getTime();
    message.usage.input = message.usage.totalTokens = tokens;
    message.usage.cost.total = cost;
    history.appendMessage(message);
  }
  await writeFile(
    path.join(getAgentDir(), "auth.json"),
    JSON.stringify({
      anthropic: {
        type: "oauth",
        access: "fixture-anthropic",
        refresh: "never-refresh",
        expires: now.getTime() + 86_400_000,
      },
    }),
  );
  const resources = await createPiResources(cwd, getAgentDir(), [
    usage,
    observer,
    scriptedProvider(fixtureModel, () => {
      const error = new Error("Unexpected model generation");
      failures.push(error);
      throw error;
    }),
  ]);
  resources.sessionManager.appendMessage({
    role: "user",
    content: "Keep the squid's log.",
    timestamp: now.getTime(),
  });
  resources.sessionManager.appendMessage(
    assistantMessage(
      Array.from({ length: 80 }, (_, index) => `Log ${index}: another peaceful reef day.`).join(
        "\n\n",
      ),
    ),
  );
  await resources.modelRuntime.setRuntimeApiKey("anthropic", "fixture-anthropic");
  return resources;
}
