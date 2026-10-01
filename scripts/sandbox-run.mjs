import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HELP = `Run a command through Pi's sandbox-aware Bash tool, without a model call.

Usage:
  sandbox-run [options] -- command [args...]
  sandbox-run [options] -c 'shell command'

Options:
  --config <file>       Use this sandbox JSON instead of global/project configs
  --cwd <directory>     Run here and resolve relative policy paths here
  --timeout <seconds>   Command timeout (no default)
  --debug               Enable sandbox-runtime diagnostics
  --trust-project       Allow this run to load .pi/sandbox.json; does not save trust
  -c, --command <text>  Run a Bash command string, including pipes and redirects
  -h, --help            Show this help

Without --config, use Pi's global sandbox.json and a trusted project's override.
Saved Pi project trust is honored. Other extensions and agent resources are not loaded.
Commands must stay sandboxed; disabled configs and matching exclusions are refused.
Approval prompts are disabled. Each run starts with fresh session permissions.
Output uses Pi's combined stdout/stderr and truncation; the audit-log path goes to stderr.
This executes the command. Allowed writes persist. Command stdin is not connected.
Run from a normal terminal to avoid inheriting an outer sandbox's restrictions.

Exit status: child status reported by Pi, 124 for timeout, 130/143 for interruption,
126 for a command-blocklist match, 1 for other failures, or 2 for invalid arguments.
`;

export async function main(argv) {
  let options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    console.error(`sandbox-run: ${error.message}\nUse --help for usage.`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const originalCwd = process.cwd();
  const originalLog = console.log;
  const controller = new AbortController();
  let interruptedCode;
  const onInterrupt = () => {
    interruptedCode = 130;
    controller.abort();
  };
  const onTerminate = () => {
    interruptedCode = 143;
    controller.abort();
  };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  // Extension startup notices belong with diagnostics, not command output.
  console.log = (...args) => console.error(...args);

  let session;
  try {
    process.chdir(options.cwd);
    if (process.env.SANDBOX_RUNTIME) {
      console.error("sandbox-run: an outer sandbox is active; its restrictions still apply.");
    }
    const {
      createAgentSession,
      DefaultResourceLoader,
      getAgentDir,
      ModelRuntime,
      ProjectTrustStore,
      SessionManager,
      SettingsManager,
    } = await import("@earendil-works/pi-coding-agent");
    const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
    const { getSandboxAuditLogPath } = await import("../extensions/sandbox/audit-log.ts");
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.inMemory(
      {},
      {
        projectTrusted:
          options.trustProject || new ProjectTrustStore(agentDir).get(options.cwd) === true,
      },
    );
    const resourceLoader = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [
        fileURLToPath(new URL("../extensions/sandbox/index.ts", import.meta.url)),
      ],
    });
    await resourceLoader.reload();
    const loaded = resourceLoader.getExtensions();
    if (loaded.errors.length || loaded.extensions.length !== 1) {
      throw new Error(
        `Could not load the sandbox extension: ${loaded.errors.map((error) => error.error).join("; ")}`,
      );
    }
    loaded.runtime.flagValues.set("sandbox-required", true);
    loaded.runtime.flagValues.set("sandbox-debug", options.debug);
    if (options.config) loaded.runtime.flagValues.set("sandbox-config", options.config);

    // Keep model configuration and credentials out of a command-only session.
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
    });
    ({ session } = await createAgentSession({
      cwd: options.cwd,
      agentDir,
      modelRuntime,
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(options.cwd),
      tools: ["bash"],
      thinkingLevel: "off",
    }));
    const extensionErrors = [];
    let shutdownRequested = false;
    await session.bindExtensions({
      mode: "print",
      onError: (error) => extensionErrors.push(error.error),
      shutdownHandler: () => {
        shutdownRequested = true;
      },
    });
    console.error(`Sandbox audit log: ${getSandboxAuditLogPath(agentDir, session.sessionId)}`);
    if (shutdownRequested || extensionErrors.length) {
      throw new Error(extensionErrors.join("; ") || "Sandbox startup failed.");
    }
    controller.signal.throwIfAborted();

    const result = await executeCommand(
      session,
      {
        command: options.command,
        ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      },
      controller.signal,
    );
    if (result.output) process.stdout.write(`${result.output}\n`);
    return interruptedCode ?? result.exitCode;
  } catch (error) {
    console.error(`sandbox-run: ${error.message}`);
    return interruptedCode ?? 1;
  } finally {
    try {
      // dispose() alone does not send session_shutdown to extensions.
      await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      session?.dispose();
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onTerminate);
      console.log = originalLog;
      process.chdir(originalCwd);
    }
  }
}

async function executeCommand(session, args, signal) {
  const tool = session.agent.state.tools.find((tool) => tool.name === "bash");
  if (!tool || !session.extensionRunner.getToolDefinition("bash")) {
    throw new Error("The sandbox Bash tool is missing. Refusing built-in Bash execution.");
  }
  const toolCall = { type: "toolCall", id: "sandbox-run", name: "bash", arguments: args };
  const preflight = await session.agent.beforeToolCall?.({ toolCall, args }, signal);
  if (preflight?.block) return { exitCode: 126, output: preflight.reason || "Command blocked." };

  let result;
  let exitCode = 0;
  try {
    result = await tool.execute(toolCall.id, args, signal);
  } catch (error) {
    result = { content: [{ type: "text", text: error.message }], details: undefined };
    exitCode = failureExitCode(error.message);
  }
  const patch = await session.agent.afterToolCall?.(
    { toolCall, args, result, isError: exitCode !== 0 },
    signal,
  );
  if (patch) {
    result = {
      ...result,
      ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
    };
    if (patch.isError === true && exitCode === 0) exitCode = 1;
  }
  return {
    exitCode,
    output: result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n"),
  };
}

export function parseOptions(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      cwd: { type: "string" },
      timeout: { type: "string" },
      debug: { type: "boolean", default: false },
      "trust-project": { type: "boolean", default: false },
      command: { type: "string", short: "c" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return { help: true };
  if (values.command !== undefined && positionals.length) {
    throw new Error("Use either -c or command arguments, not both.");
  }
  const command = values.command ?? positionals.map(shellQuote).join(" ");
  if (!command.trim()) throw new Error("A command is required.");
  const timeout = values.timeout === undefined ? undefined : Number(values.timeout);
  if (
    timeout !== undefined &&
    (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > 2_147_483_647)
  ) {
    throw new Error("Timeout must be between 0 and 2147483.647 seconds, exclusive of 0.");
  }
  return {
    command,
    cwd: realpathSync(resolve(values.cwd ?? ".")),
    config: values.config === undefined ? undefined : resolve(values.config),
    timeout,
    debug: values.debug,
    trustProject: values["trust-project"],
  };
}

function shellQuote(arg) {
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

export function failureExitCode(message) {
  // Pi's Bash tool reports process status in the final error line, not details.
  const match = /(?:^|\n)Command exited with code (\d+)$/.exec(message);
  if (match) {
    const code = Number(match[1]);
    if (code > 0 && code <= 255) return code;
  }
  if (/(?:^|\n)Command timed out after [\d.]+ seconds$/.test(message)) return 124;
  if (/(?:^|\n)Command aborted$/.test(message)) return 130;
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
