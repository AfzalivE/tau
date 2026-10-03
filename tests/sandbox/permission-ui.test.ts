import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  createAgentSession,
  initTheme,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import {
  showSandboxPermissionSelect,
  type SandboxPermissionPrompt,
} from "../../extensions/sandbox/permissions/prompt.js";
import { createSandboxRuntime, type SandboxRuntime } from "../../extensions/sandbox/runtime.js";
import { deadline } from "../helpers/async.js";
import { mountCustomUI } from "../helpers/custom-ui.js";
import { createPiResources, fixtureModel, uiBoundary } from "../helpers/pi.js";

const choices = ["Allow and retry now", "Allow but adapt for side-effects", "Deny"];
const prompt: SandboxPermissionPrompt = {
  request: "File write",
  target: "/otter/secret recipe.txt",
  requester: "otter-chef (42)",
  command: "printf 'paprika' > '/otter/secret recipe.txt'",
  typeCode: "FS",
};

describe("sandbox permission UI", () => {
  let cwd: string;
  let resources: Awaited<ReturnType<typeof createPiResources>>;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  let runtime: SandboxRuntime;
  let errors: unknown[];
  let theme: ExtensionUIContext["theme"];

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "tau-permission-ui-"));
    errors = [];
    resources = await createPiResources(cwd, path.join(cwd, "agent"), [
      (api) => {
        runtime = createSandboxRuntime(api);
        api.on("session_start", (_event, ctx) => runtime.captureContext(ctx));
      },
    ]);
    ({ session } = await createAgentSession({ ...resources, model: fixtureModel, tools: [] }));
    initTheme("dark", false);
    theme = session.extensionRunner.getUIContext().theme;
  });

  afterEach(async () => {
    try {
      await session?.abort();
      await resources?.settingsManager.flush();
      assert.deepEqual(errors, [], "Unexpected Pi or UI errors must remain visible");
    } finally {
      session?.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("shows a compact bordered warning with fields and keyboard choices", async () => {
    const cases: {
      prompt: SandboxPermissionPrompt;
      targetLabel: string;
      answer: string | undefined;
      keys: string[];
    }[] = [
      { prompt, targetLabel: "target", answer: choices[1], keys: ["\x1b[B", "\r"] },
      {
        prompt: {
          request: "Network access",
          target: "otter.test:443",
          targetLabel: "host",
          typeCode: "NET",
        },
        targetLabel: "host",
        answer: undefined,
        keys: ["\x1b[B", "\x1b[A", "\x1b"],
      },
    ];
    for (const entry of cases) {
      await session.bindExtensions({
        mode: "tui",
        onError: (error) => errors.push(error),
        uiContext: uiBoundary(
          {
            theme,
            async custom(factory, options) {
              const view = await mountCustomUI(factory, theme, { columns: 120 }, options);
              try {
                const lines = plainLines(view.component.render(120));
                const rendered = lines.join("\n");
                assert.match(lines[0]!, /^╭─+╮$/);
                assert.match(rendered, /SANDBOX BLOCKED/);
                assert.ok(rendered.includes(entry.prompt.request), rendered);
                assert.ok(rendered.includes(entry.prompt.typeCode), rendered);
                assert.ok(rendered.includes(entry.targetLabel), rendered);
                assert.ok(rendered.includes(entry.prompt.target), rendered);
                assert.ok(
                  lines.some((line) => /^├─+┤$/.test(line)),
                  rendered,
                );
                assert.ok(
                  lines.some((line) => /^╰─+╯$/.test(line)),
                  rendered,
                );
                if (entry.prompt.requester) {
                  assert.match(rendered, /process\s+otter-chef \(42\)/);
                  assert.ok(rendered.includes(entry.prompt.command!), rendered);
                  assert.match(rendered, /command/);
                } else {
                  assert.doesNotMatch(rendered, /process|command/);
                }
                assert.doesNotMatch(
                  rendered,
                  /scope|descendants|host filesystem|for this session/i,
                );
                for (const choice of choices) assert.ok(rendered.includes(choice), rendered);
                assert.match(rendered, /navigate.*select.*cancel/i);
                assert.match(rendered, /→ Allow and retry now/);
                assert.ok(view.component.handleInput);
                for (const key of entry.keys) view.component.handleInput(key);
                if (entry.answer) {
                  assert.match(
                    plainLines(view.component.render(120)).join("\n"),
                    /→ Allow but adapt for side-effects/,
                  );
                }
                return await deadline(view.result, "permission keyboard answer");
              } finally {
                view.dispose();
              }
            },
          },
          errors,
        ),
      });
      assert.equal(
        await showSandboxPermissionSelect(runtime.context!, entry.prompt, choices),
        entry.answer,
      );
    }
  });

  test("renders terminal and bidi controls as visible data in every external field", async () => {
    const unsafePrompt = {
      request: "Write\u202e",
      target: "/otter\x1b[31m\n\u2066den",
      requester: "chef\r\t\x07\u0085",
      command: "printf '\u2028\u2029\u200b'",
      targetLabel: "p\u2066",
      typeCode: "F\u202d",
    };
    await session.bindExtensions({
      mode: "tui",
      onError: (error) => errors.push(error),
      uiContext: uiBoundary(
        {
          theme,
          async custom(factory, options) {
            const view = await mountCustomUI(factory, theme, undefined, options);
            try {
              const raw = view.component.render(160).join("\n");
              const rendered = plainLines([raw]).join("\n");
              for (const value of [
                String.raw`Write\u202e`,
                String.raw`/otter\u001b[31m\u000a\u2066den`,
                String.raw`chef\u000d\u0009\u0007\u0085`,
                String.raw`printf '\u2028\u2029\u200b'`,
                String.raw`p\u2066`,
                String.raw`F\u202d`,
              ])
                assert.ok(rendered.includes(value), rendered);
              // Check raw output too: stripping terminal controls must not hide an injection.
              assert.ok(!raw.includes("\x1b[31m"), "Untrusted ANSI escaped into the terminal");
              assert.doesNotMatch(rendered.replaceAll("\n", ""), /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
              assert.ok(view.component.handleInput);
              view.component.handleInput("\x1b");
              return await deadline(view.result, "escaped permission dismissal");
            } finally {
              view.dispose();
            }
          },
        },
        errors,
      ),
    });
    assert.equal(
      await showSandboxPermissionSelect(runtime.context!, unsafePrompt, choices),
      undefined,
    );
  });

  test("fits narrow terminals and Unicode without accepting a clipped choice", async () => {
    const unicodePrompt = {
      ...prompt,
      target: "/海獺/🦦/cafe\u0301/".repeat(12),
      requester: "海獺 🦦 cafe\u0301",
      command: "printf '海獺 🦦 cafe\u0301' ".repeat(12),
    };
    const dimensions = [
      ...[1, 2, 3, 4, 8, 16, 22, 23, 32, 48, 96, 160].map((columns) => ({
        columns,
        width: columns,
      })),
      { columns: 160, width: 8 },
    ];
    for (const { columns, width } of dimensions) {
      let fullChoiceVisible = false;
      await session.bindExtensions({
        mode: "tui",
        onError: (error) => errors.push(error),
        uiContext: uiBoundary(
          {
            theme,
            async custom(factory, options) {
              const view = await mountCustomUI(factory, theme, { columns }, options);
              try {
                const lines = view.component.render(width);
                for (const line of lines) {
                  assert.ok(
                    visibleWidth(line) <= width,
                    `${width}-column dock overflow: ${JSON.stringify(line)}`,
                  );
                }
                if (width >= 96) {
                  const rendered = plainLines(lines).join("\n");
                  assert.ok(rendered.includes("海獺"), rendered);
                  assert.ok(rendered.includes("🦦"), rendered);
                  assert.ok(rendered.includes("cafe\u0301"), rendered);
                }
                const selectedLine = plainLines(lines).find((line) =>
                  line.trimStart().startsWith("→"),
                );
                fullChoiceVisible = selectedLine?.trim() === `→ ${choices[0]}`;
                if (width === 22) assert.equal(fullChoiceVisible, false, selectedLine);
                if (width === 23) assert.equal(fullChoiceVisible, true, selectedLine);
                assert.ok(view.component.handleInput);
                view.component.handleInput("\r");
                view.component.handleInput("\x1b");
                return await deadline(view.result, "narrow permission dismissal");
              } finally {
                view.dispose();
              }
            },
          },
          errors,
        ),
      });
      assert.equal(
        await showSandboxPermissionSelect(runtime.context!, unicodePrompt, choices),
        fullChoiceVisible ? choices[0] : undefined,
        `Only a fully displayed choice can be confirmed in a ${width}-column dock on a ${columns}-column terminal`,
      );
    }
  });

  test("uses the native RPC selector and does not open a headless dialog", async () => {
    let selections = 0;
    for (const mode of ["print", "json", "rpc"] as const) {
      await session.bindExtensions({
        mode,
        onError: (error) => errors.push(error),
        uiContext:
          mode === "rpc"
            ? uiBoundary(
                {
                  theme,
                  async select(title, options) {
                    selections++;
                    assert.equal(mode, "rpc");
                    assert.ok(title.includes(String.raw`/otter\u001b[31m\u202eden`), title);
                    assert.ok(title.includes(prompt.requester!), title);
                    assert.ok(title.includes(prompt.command!), title);
                    assert.doesNotMatch(title.replaceAll("\n", ""), /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
                    assert.deepEqual(options, choices);
                    return choices[2];
                  },
                },
                errors,
              )
            : undefined,
      });
      const ctx = session.extensionRunner.createContext();
      assert.equal(ctx.hasUI, mode === "rpc");
      assert.equal(
        await showSandboxPermissionSelect(
          ctx,
          { ...prompt, target: "/otter\x1b[31m\u202eden" },
          choices,
        ),
        mode === "rpc" ? choices[2] : undefined,
      );
    }
    assert.equal(selections, 1);
  });

  test("shutdown cancels and joins a captured-context dialog without accepting a late approval", async () => {
    let shutdown: Promise<void> | undefined;
    let disposed = false;
    await session.bindExtensions({
      mode: "tui",
      onError: (error) => errors.push(error),
      uiContext: uiBoundary(
        {
          theme,
          setStatus() {},
          async custom(factory, options) {
            const view = await mountCustomUI(factory, theme, undefined, options);
            try {
              view.component.render(160);
              shutdown = runtime.shutdown(session.extensionRunner.createContext()).then(() => {
                assert.equal(disposed, true, "Shutdown must join dialog cleanup");
              });
              assert.ok(view.component.handleInput);
              view.component.handleInput("\r");
              return await deadline(view.result, "shutdown-owned permission dismissal");
            } catch (error) {
              errors.push(error);
              throw error;
            } finally {
              view.dispose();
              disposed = true;
            }
          },
        },
        errors,
      ),
    });
    assert.equal(await showSandboxPermissionSelect(runtime.context!, prompt, choices), undefined);
    assert.ok(shutdown, "The captured context must open a custom dialog before shutdown");
    await deadline(shutdown, "permission lifecycle shutdown");
    assert.equal(runtime.context, null);
  });

  test("operation cancellation closes the custom dialog and leaves the next invocation usable", async () => {
    const controller = new AbortController();
    let dialogs = 0;
    await session.bindExtensions({
      mode: "tui",
      onError: (error) => errors.push(error),
      uiContext: uiBoundary(
        {
          theme,
          async custom(factory, options) {
            const view = await mountCustomUI(factory, theme, undefined, options);
            try {
              view.component.render(160);
              dialogs++;
              assert.ok(view.component.handleInput);
              if (dialogs === 1) {
                controller.abort();
                // A late key must not turn an aborted invocation into an approval.
                view.component.handleInput("\r");
              } else {
                view.component.handleInput("\x1b[B");
                view.component.handleInput("\r");
              }
              return await deadline(view.result, "operation-owned permission dialog");
            } catch (error) {
              errors.push(error);
              throw error;
            } finally {
              view.dispose();
            }
          },
        },
        errors,
      ),
    });
    const ctx = session.extensionRunner.createContext();
    let operationSignal: AbortSignal | undefined;
    const request = (signal?: AbortSignal) =>
      runtime.withPermissionContext(ctx, signal, (invocation) => {
        operationSignal = invocation.signal;
        return showSandboxPermissionSelect(invocation, prompt, choices);
      });
    assert.equal(await request(controller.signal), undefined);
    assert.equal(
      operationSignal?.aborted,
      true,
      "Post-dialog work must inherit operation cancellation",
    );
    await assert.rejects(request(controller.signal), /aborted/);
    assert.equal(dialogs, 1, "An already aborted operation must not mount a dialog");
    assert.equal(await request(), choices[1]);
    assert.equal(dialogs, 2);
  });
});

/** Remove trusted renderer styling and its cursor marker, preserving field content. */
function plainLines(lines: string[]): string[] {
  return lines.map((line) => stripVTControlCharacters(line).replaceAll(CURSOR_MARKER, ""));
}
