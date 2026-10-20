import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";
import { promisify } from "node:util";
import {
  createEditTool,
  ExtensionRunner,
  getAgentDir,
  ModelRegistry,
  type MarkdownTransformContext,
} from "@earendil-works/pi-coding-agent";
import { setCapabilityOverrides } from "@earendil-works/pi-tui";
import codeLinks from "../extensions/code-links/index.js";
import { createPiResources, isolatePiHome, uiBoundary } from "./helpers/pi.js";

type RecordedTag = { name: string; pattern: string; line: number; kind: string; scope?: string };
type Signal = "redraw" | "notice";

const sources = {
  "app/src/Lighthouse.kt": [
    "class Lighthouse(",
    "    keeper: Keeper,",
    ") : Beacon(), Keeper by keeper {",
    "    override fun shine() {",
    "        lamp.pause {",
    "            sweep()",
    "        }",
    "    }",
    "",
    "    fun sweep() {}",
    "",
    "    fun sweep(degrees: Int) {}",
    "",
    "    companion object {",
    "        fun build() {}",
    "    }",
    "}",
  ],
  "app/src/Buoy.kt": ["class Buoy {", "    fun shine() {}", "}"],
  "app/src/Beacon.kt": [
    "package harbor",
    "",
    "fun Lighthouse.dim(level: Int) {}",
    "",
    "internal fun <T : Any> Lighthouse?.signal(message: T): T = message",
    "",
    "val Lighthouse.range: Int",
    "    get() = 12",
  ],
  "app/src/Fog.kt": ["class Fog {", "    fun dim() {}", "}"],
};

// Universal Ctags 6.2.1 output for the sources. Interface delegation drops the class scope of
// every Lighthouse member, so ownership must come from indentation.
const lighthouseTags: RecordedTag[] = [
  {
    name: "<lambda>",
    pattern: "/^        lamp.pause {$/",
    line: 5,
    kind: "method",
    scope: "shine",
  },
  { name: "Companion", pattern: "/^    companion object {$/", line: 14, kind: "object" },
  { name: "Lighthouse", pattern: "/^class Lighthouse($/", line: 1, kind: "class" },
  {
    name: "build",
    pattern: "/^        fun build() {}$/",
    line: 15,
    kind: "method",
    scope: "Companion",
  },
  { name: "shine", pattern: "/^    override fun shine() {$/", line: 4, kind: "method" },
  { name: "sweep", pattern: "/^    fun sweep() {}$/", line: 10, kind: "method" },
  { name: "sweep", pattern: "/^    fun sweep(degrees: Int) {}$/", line: 12, kind: "method" },
];
const buoyClass: RecordedTag = {
  name: "Buoy",
  pattern: "/^class Buoy {$/",
  line: 1,
  kind: "class",
};
const buoyShine: RecordedTag = {
  name: "shine",
  pattern: "/^    fun shine() {}$/",
  line: 2,
  kind: "method",
  scope: "Buoy",
};

// Universal Ctags 6.2.1 scopes Kotlin extensions to their package, so the receiver comes from
// the declaration.
const beaconTags: RecordedTag[] = [
  { name: "harbor", pattern: "/^package harbor$/", line: 1, kind: "package" },
  {
    name: "dim",
    pattern: "/^fun Lighthouse.dim(level: Int) {}$/",
    line: 3,
    kind: "method",
    scope: "harbor",
  },
  {
    name: "signal",
    pattern: "/^internal fun <T : Any> Lighthouse?.signal(message: T): T = message$/",
    line: 5,
    kind: "method",
    scope: "harbor",
  },
  {
    name: "range",
    pattern: "/^val Lighthouse.range: Int$/",
    line: 7,
    kind: "constant",
    scope: "harbor",
  },
];
const fogTags: RecordedTag[] = [
  { name: "Fog", pattern: "/^class Fog {$/", line: 1, kind: "class" },
  { name: "dim", pattern: "/^    fun dim() {}$/", line: 2, kind: "method", scope: "Fog" },
];

const finished: MarkdownTransformContext = {
  messageType: "assistant",
  isStreaming: false,
  availableWidth: 80,
};

describe("code-links", { concurrency: false }, () => {
  let home: Awaited<ReturnType<typeof isolatePiHome>> | undefined;
  let directory: string;
  let repo: string;
  let bins: Awaited<ReturnType<typeof installBins>>;
  let failures: unknown[];
  let children: Promise<unknown>[];
  let extensions: { dispose(): Promise<void> }[];
  let originalPath: string | undefined;

  before(async () => {
    home = await isolatePiHome();
  });

  after(async () => home?.dispose());

  beforeEach(async () => {
    failures = [];
    children = [];
    extensions = [];
    originalPath = process.env.PATH;
    setCapabilityOverrides({ hyperlinks: true });
    directory = await mkdtemp(path.join(os.tmpdir(), "tau-code-links-"));
    repo = path.join(directory, "harbor");
    await mkdir(repo);
    await execFile("git", ["init", "--initial-branch=main", "--template="], { cwd: repo });
    for (const [file, lines] of Object.entries(sources)) {
      await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
      await writeFile(path.join(repo, file), `${lines.join("\n")}\n`);
    }
    bins = await installBins(directory);
    await bins.record({
      "app/src/Lighthouse.kt": lighthouseTags,
      "app/src/Buoy.kt": [buoyClass, buoyShine],
      "app/src/Beacon.kt": beaconTags,
      "app/src/Fog.kt": fogTags,
    });
    // BSD ctags comes first, as with Xcode's /usr/bin/ctags before Homebrew on macOS.
    process.env.PATH = [bins.bsd, bins.universal, bins.git].join(path.delimiter);
    mock.method(globalThis, "fetch", (request: unknown) => {
      failures.push(request);
      throw new Error("Unexpected network request in code-links test");
    });
    // Pass through Git and ctags in the fixture directory; reject any other process.
    const spawn = childProcess.spawn;
    mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
      const [command, , options] = args;
      if (
        (command === "git" || path.basename(command) === "ctags") &&
        typeof options?.cwd === "string" &&
        options.cwd.startsWith(directory)
      ) {
        const child = spawn(...args);
        children.push(once(child, "close"));
        return child;
      }
      failures.push(args);
      throw new Error("Unexpected process in code-links test");
    });
    syncBuiltinESMExports();
  });

  afterEach(async () => {
    try {
      for (const extension of extensions) await extension.dispose();
      await settled(children);
      assert.deepEqual(failures, [], "unexpected work and extension errors must not be swallowed");
    } finally {
      process.env.PATH = originalPath;
      setCapabilityOverrides({});
      mock.restoreAll();
      syncBuiltinESMExports();
      await rm(path.join(getAgentDir(), "code-links.json"), { force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("links members, companions, overloads, and files once the index is ready", async () => {
    const pi = await start(repo);
    const lighthouse = path.join(repo, "app/src/Lighthouse.kt");
    const buoy = path.join(repo, "app/src/Buoy.kt");

    assert.equal(
      pi.render(
        "Call Lighthouse.shine(), then `Lighthouse.build()` and Lighthouse.sweep(). See app/src/Buoy.kt:2.",
      ),
      `Call [Lighthouse.shine()](zed://file${lighthouse}:4), ` +
        `then [\`Lighthouse.build()\`](zed://file${lighthouse}:15) ` +
        `and [Lighthouse.sweep()](zed://file${lighthouse}:10). ` +
        `See [app/src/Buoy.kt:2](zed://file${buoy}:2).`,
    );
    for (const plain of [
      "Both define `shine`, and Lighthouse keeps watch.",
      "```kotlin\nLighthouse.shine()\n```",
      "[Buoy](https://example.com/Buoy.kt) <https://example.com/app/src/Buoy.kt>",
    ])
      assert.equal(pi.render(plain), plain);
    assert.equal(
      pi.render("Lighthouse.shine()", { ...finished, isStreaming: true }),
      "Lighthouse.shine()",
    );
  });

  test("/code-links switches the editor, redraws, and a new session keeps the choice", async () => {
    const pi = await start(repo);
    const lighthouse = path.join(repo, "app/src/Lighthouse.kt");

    await pi.observe("redraw", () => pi.command(""));
    assert.equal(
      pi.render("Lighthouse.build()"),
      `[Lighthouse.build()](idea://open?file=${encodeURIComponent(lighthouse)}&line=15)`,
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(getAgentDir(), "code-links.json"), "utf8")),
      { editor: "studio" },
    );
    await pi.command("vim");
    assert.deepEqual(pi.notices.at(-1), [
      "error",
      'Unknown editor "vim". Use one of: zed, vscode, vscode-insiders, vscodium, cursor, idea, studio, textmate, macvim, nova, file',
    ]);

    const next = await start(repo);
    await settled(children);
    assert.match(next.render("Lighthouse.build()"), /\(idea:\/\/open\?file=/);
  });

  test("links Kotlin extensions through their receiver type", async () => {
    const pi = await start(repo);
    const beacon = path.join(repo, "app/src/Beacon.kt");

    assert.equal(
      pi.render(
        "Lighthouse.dim(level) dims it, `Lighthouse.signal(message)` and `Lighthouse.range` " +
          "too, and Fog.dim() thins out.",
      ),
      `[Lighthouse.dim](zed://file${beacon}:3)(level) dims it, ` +
        `[\`Lighthouse.signal(message)\`](zed://file${beacon}:5) and ` +
        `[\`Lighthouse.range\`](zed://file${beacon}:7) too, and ` +
        `[Fog.dim()](zed://file${path.join(repo, "app/src/Fog.kt")}:2) thins out.`,
    );
    // Both files define dim, so the bare name stays plain.
    assert.equal(pi.render("`dim`"), "`dim`");
  });

  // Each editor documents its own URL format; these are the exact links for a line and column.
  for (const [editor, url] of [
    ["zed", (file: string) => `zed://file${file}:2:5`],
    ["vscode", (file: string) => `vscode://file${file}:2:5`],
    ["vscode-insiders", (file: string) => `vscode-insiders://file${file}:2:5`],
    ["vscodium", (file: string) => `vscodium://file${file}:2:5`],
    ["cursor", (file: string) => `cursor://file${file}:2:5`],
    ["idea", (file: string) => `idea://open?file=${encodeURIComponent(file)}&line=2&column=5`],
    ["studio", (file: string) => `idea://open?file=${encodeURIComponent(file)}&line=2&column=5`],
    [
      "textmate",
      (file: string) => `txmt://open/?url=${encodeURIComponent(`file://${file}`)}&line=2&column=5`,
    ],
    [
      "macvim",
      (file: string) => `mvim://open?url=${encodeURIComponent(`file://${file}`)}&line=2&column=5`,
    ],
    ["nova", (file: string) => `nova://open?path=${encodeURIComponent(file)}&line=2:5`],
    ["file", (file: string) => `file://${file}`],
  ] as const) {
    test(`links a file position for ${editor}`, async () => {
      const pi = await start(repo);
      await pi.command(editor);
      assert.equal(
        pi.render("app/src/Buoy.kt:2:5"),
        `[app/src/Buoy.kt:2:5](${url(path.join(repo, "app/src/Buoy.kt"))})`,
      );
    });
  }

  test("refreshes an edited file and redraws the transcript", async () => {
    const pi = await start(repo);
    assert.equal(pi.render("`shine`"), "`shine`");

    const input = {
      path: "app/src/Buoy.kt",
      edits: [{ oldText: "    fun shine() {}\n", newText: "" }],
    };
    const result = await createEditTool(repo).execute("calm-seas", input);
    await bins.record({
      "app/src/Lighthouse.kt": lighthouseTags,
      "app/src/Buoy.kt": [buoyClass],
      "app/src/Beacon.kt": beaconTags,
      "app/src/Fog.kt": fogTags,
    });
    await pi.observe("redraw", () =>
      pi.runner.emitToolResult({
        type: "tool_result",
        toolName: "edit",
        toolCallId: "calm-seas",
        input,
        content: result.content,
        details: result.details,
        isError: false,
      }),
    );
    assert.equal(
      pi.render("`shine`"),
      `[\`shine\`](zed://file${path.join(repo, "app/src/Lighthouse.kt")}:4)`,
    );
  });

  test("drops an index that finishes after reload", async () => {
    const stale = await openExtension(repo);
    await stale.runner.emit({ type: "session_start", reason: "startup" });
    await stale.runner.emit({ type: "session_shutdown", reason: "reload" });
    stale.runner.invalidate();
    await settled(children);
    assert.equal(stale.redraws, 0);
    assert.equal(stale.render("Lighthouse.shine()"), "Lighthouse.shine()");
  });

  test("warns without Universal Ctags and stays quiet outside Git", async () => {
    process.env.PATH = [bins.bsd, bins.git].join(path.delimiter);
    const warned = await openExtension(repo);
    await warned.observe("notice", () =>
      warned.runner.emit({ type: "session_start", reason: "startup" }),
    );
    assert.deepEqual(warned.notices, [
      [
        "warning",
        "code-links: Universal Ctags is not on PATH. Install it, for example with: brew install universal-ctags",
      ],
    ]);

    const outside = path.join(directory, "notes");
    await mkdir(outside);
    const quiet = await openExtension(outside);
    await quiet.observe("redraw", () =>
      quiet.runner.emit({ type: "session_start", reason: "startup" }),
    );
    assert.deepEqual(quiet.notices, []);
  });

  test("resolves delegated Kotlin members and extensions with an installed Universal Ctags", async (t) => {
    const installed = await findUniversalCtags(originalPath);
    if (!installed) {
      t.skip("Universal Ctags is not installed");
      return;
    }
    process.env.PATH = [path.dirname(installed), bins.git].join(path.delimiter);
    const pi = await start(repo);
    assert.equal(
      pi.render("Lighthouse.shine(), `Lighthouse.build()`, and `Lighthouse.signal(message)`"),
      `[Lighthouse.shine()](zed://file${path.join(repo, "app/src/Lighthouse.kt")}:4), ` +
        `[\`Lighthouse.build()\`](zed://file${path.join(repo, "app/src/Lighthouse.kt")}:15), and ` +
        `[\`Lighthouse.signal(message)\`](zed://file${path.join(repo, "app/src/Beacon.kt")}:5)`,
    );
  });

  /** Open the extension and wait for its index to redraw the transcript. */
  async function start(cwd: string) {
    const pi = await openExtension(cwd);
    await pi.observe("redraw", () => pi.runner.emit({ type: "session_start", reason: "startup" }));
    return pi;
  }

  /**
   * Load code-links in a real extension runner. Only the UI boundary is substituted: widget
   * factories receive a terminal that counts transcript invalidations.
   */
  async function openExtension(cwd: string) {
    const { resourceLoader, modelRuntime, sessionManager } = await createPiResources(
      cwd,
      getAgentDir(),
      [codeLinks],
    );
    const loaded = resourceLoader.getExtensions();
    const runner = new ExtensionRunner(
      loaded.extensions,
      loaded.runtime,
      cwd,
      sessionManager,
      new ModelRegistry(modelRuntime),
    );
    runner.onError((error) => failures.push(error));
    const notices: [string | undefined, string][] = [];
    let redraws = 0;
    let waiting: { signal: Signal; resolve: () => void } | undefined;
    const signal = (kind: Signal) => {
      if (waiting?.signal === kind) waiting!.resolve();
    };
    const terminal = {
      invalidate() {
        redraws++;
        signal("redraw");
      },
      requestRender() {},
    };
    runner.setUIContext(
      uiBoundary(
        {
          setWidget(_key: string, content: unknown) {
            if (typeof content === "function") content(terminal, undefined);
          },
          notify(message, level) {
            notices.push([level, message]);
            signal("notice");
          },
          select: async (_title, options) => options.find((option) => option === "studio"),
        },
        failures,
      ),
      "tui",
    );
    const extension = {
      runner,
      notices,
      get redraws() {
        return redraws;
      },
      render(markdown: string, context = finished) {
        return runner
          .getMarkdownTransformers()
          .reduce((text, transform) => transform(text, context), markdown);
      },
      command(args: string) {
        return runner.getCommand("code-links")!.handler(args, runner.createCommandContext());
      },
      /** Run an action and wait for the next transcript redraw or notice it causes. */
      async observe(kind: Signal, action: () => Promise<unknown>) {
        const next = new Promise<void>((resolve) => (waiting = { signal: kind, resolve }));
        try {
          await Promise.all([
            action(),
            deadline(next, () => `No ${kind}. Notices: ${JSON.stringify(notices)}`),
          ]);
        } finally {
          waiting = undefined;
        }
      },
      async dispose() {
        try {
          await runner.emit({ type: "session_shutdown", reason: "quit" });
        } finally {
          runner.invalidate();
        }
      },
    };
    extensions.push(extension);
    return extension;
  }
});

const execFile = promisify(childProcess.execFile);

/**
 * Create PATH directories: a BSD-style ctags that rejects Universal Ctags options, a ctags that
 * replays recorded Universal Ctags output for the files listed on stdin, and the real Git.
 */
async function installBins(root: string) {
  const bins = {
    bsd: path.join(root, "bsd-bin"),
    universal: path.join(root, "universal-bin"),
    git: path.join(root, "git-bin"),
  };
  for (const directory of Object.values(bins)) await mkdir(directory);
  const tags = path.join(root, "tags.json");
  await writeExecutable(
    path.join(bins.bsd, "ctags"),
    `#!/bin/sh\necho "ctags: illegal option -- -" >&2\nexit 1\n`,
  );
  await writeExecutable(
    path.join(bins.universal, "ctags"),
    `#!${process.execPath}
const fs = require("node:fs");
if (process.argv[2] === "--version") {
  console.log("Universal Ctags 6.2.1, Copyright (C) 2015-2025 Universal Ctags Team");
  process.exit(0);
}
const tags = JSON.parse(fs.readFileSync(${JSON.stringify(tags)}, "utf8"));
for (const file of fs.readFileSync(0, "utf8").split("\\n"))
  for (const tag of tags[file] ?? []) console.log(JSON.stringify({ _type: "tag", path: file, ...tag }));
`,
  );
  const { stdout } = await execFile("sh", ["-c", "command -v git"]);
  await symlink(stdout.trim(), path.join(bins.git, "git"));
  return {
    ...bins,
    /** Replace what the replayed ctags reports for each file. */
    record: (recorded: Record<string, RecordedTag[]>) => writeFile(tags, JSON.stringify(recorded)),
  };
}

async function findUniversalCtags(searchPath: string | undefined) {
  for (const directory of (searchPath ?? "").split(path.delimiter)) {
    const candidate = path.join(directory, "ctags");
    try {
      const { stdout } = await execFile(candidate, ["--version"]);
      if (stdout.startsWith("Universal Ctags")) return candidate;
    } catch {}
  }
  return undefined;
}

async function writeExecutable(file: string, content: string) {
  await writeFile(file, content);
  await chmod(file, 0o755);
}

/** Wait for every started process, then for the promise callbacks that its output resolves. */
async function settled(children: Promise<unknown>[]) {
  for (let count = -1; count !== children.length; ) {
    count = children.length;
    await Promise.all(children);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Reject after a safety deadline, with a message built when it expires. */
function deadline<T>(promise: Promise<T>, message: () => string) {
  let timeout: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message())), 10_000);
    }),
  ]).finally(() => clearTimeout(timeout));
}
