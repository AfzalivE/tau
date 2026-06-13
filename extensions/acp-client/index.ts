/**
 * ACP client extension: use Claude and Codex agents from Pi.
 *
 * What this extension does:
 * - Registers an `acp_agent` tool so the model can delegate tasks to external
 *   coding agents (Claude or Codex) over the Agent Client Protocol.
 * - Registers an /acp command so the user can drive those agents directly,
 *   with replies recorded in the session as custom messages.
 * - Agent permission requests (run a command, edit a file, ...) surface as
 *   interactive prompts; without UI they fall back to rejection.
 *
 * Commands:
 * - /acp <claude|codex> <prompt>   prompt the agent (conversation persists per agent)
 * - /acp new <claude|codex> <prompt>   start a fresh conversation, then prompt
 * - /acp view [claude|codex]   tail a running agent's transcript live
 * - /acp stop   stop all running agents and their processes
 *
 * Agent processes are spawned lazily via `npx` adapters and reused for the
 * lifetime of the Pi session. Launch commands can be overridden in
 * ~/.pi/acp.json: { "agents": { "claude": { "command": "...", "args": [...] } } }
 */

import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import {
  defineTool,
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { ACP_AGENT_LABELS, isAcpAgentId, loadConfig } from "./config.js";
import { AcpConnection } from "./connection.js";
import { renderAcpCall, renderAcpResult } from "./render.js";
import { AcpRun, AcpRunRegistry } from "./runs.js";
import { AcpSessionViewer } from "./viewer.js";
import type { AcpAgentId, AcpMessageDetails, AcpToolDetails } from "./types.js";

const CUSTOM_MESSAGE_TYPE = "acp-agent";
const STATUS_SPINNER_INTERVAL_MS = 80;
const STATUS_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const USAGE = "Usage: /acp [new] <claude|codex> <prompt>, /acp view [agent], /acp stop";

export default function acpExtension(pi: ExtensionAPI): void {
  const connections = new Map<AcpAgentId, AcpConnection>();
  const commandSessions = new Map<AcpAgentId, string>();
  const commandRuns = new Map<AcpAgentId, AbortController>();
  const runs = new AcpRunRegistry();

  function getOrCreateConnection(agent: AcpAgentId): AcpConnection {
    let connection = connections.get(agent);
    if (connection && !connection.alive) {
      connection.dispose();
      connections.delete(agent);
      commandSessions.delete(agent);
      connection = undefined;
    }
    if (!connection) {
      connection = new AcpConnection(agent, loadConfig().agents[agent]);
      connections.set(agent, connection);
    }
    return connection;
  }

  function disposeAll(): void {
    for (const controller of commandRuns.values()) controller.abort();
    commandRuns.clear();
    for (const connection of connections.values()) connection.dispose();
    connections.clear();
    commandSessions.clear();
  }

  pi.registerTool(
    defineTool({
      name: "acp_agent",
      label: "ACP Agent",
      description:
        "Delegate a task to an external coding agent (Claude or Codex) running in this workspace " +
        "via the Agent Client Protocol. The agent works autonomously with its own tools and " +
        "returns its final answer. To continue a conversation, pass the sessionId returned by a " +
        "previous call; omit it to start fresh.",
      promptSnippet: "Delegate tasks to external Claude/Codex agents",
      parameters: Type.Object({
        agent: Type.Union([Type.Literal("claude"), Type.Literal("codex")], {
          description: "Which agent to use",
        }),
        prompt: Type.String({ description: "Task or question for the agent" }),
        sessionId: Type.Optional(
          Type.String({
            description: "Session ID from a previous acp_agent call to continue that conversation",
          }),
        ),
      }),
      renderShell: "self",
      renderCall(args, theme) {
        return renderAcpCall(args.agent, args.prompt, args.sessionId, theme);
      },
      renderResult(result, { expanded }, theme, context) {
        const content = result.content.find((item) => item.type === "text");
        const text = content?.type === "text" ? content.text : "";
        const details = (result.details ?? { agent: "claude", entries: [] }) as AcpToolDetails;
        return renderAcpResult(details, text, expanded, context.isError, theme);
      },
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const connection = getOrCreateConnection(params.agent);

        let sessionId = params.sessionId;
        if (sessionId && !connection.hasSession(sessionId)) {
          throw new Error(
            `Unknown ${params.agent} session ${sessionId} (the agent may have restarted). ` +
              "Call acp_agent again without sessionId to start a new session.",
          );
        }

        const run = runs.create(params.agent, "tool", params.prompt);
        const { recorder } = run;
        try {
          sessionId ??= await connection.newSession(ctx.cwd);
          run.sessionId = sessionId;

          const details: AcpToolDetails = {
            agent: params.agent,
            sessionId,
            entries: recorder.entries,
          };
          const response = await connection.prompt(
            sessionId,
            params.prompt,
            {
              onUpdate: (update) => {
                recorder.handleUpdate(update);
                run.notify();
                onUpdate?.({
                  content: [{ type: "text", text: recorder.progressLabel }],
                  details,
                });
              },
              requestPermission: (request) => resolvePermission(ctx, run, request),
            },
            signal,
          );

          details.stopReason = response.stopReason;
          run.finish("done");
          const answer = recorder.finalText || "(no response)";
          const text = `[${params.agent} session: ${sessionId}, stop reason: ${response.stopReason}]\n\n${answer}`;
          return { content: [{ type: "text", text }], details };
        } catch (error) {
          run.finish("error", error instanceof Error ? error.message : String(error));
          throw error;
        } finally {
          runs.remove(run);
        }
      },
    }),
  );

  pi.registerCommand("acp", {
    description: "Prompt a Claude or Codex agent via ACP",
    getArgumentCompletions(argumentPrefix) {
      const items = [
        { value: "claude ", label: "claude", description: "Prompt the Claude agent" },
        { value: "codex ", label: "codex", description: "Prompt the Codex agent" },
        { value: "new ", label: "new", description: "Start a fresh conversation" },
        { value: "view", label: "view", description: "Tail a running agent's transcript" },
        { value: "stop", label: "stop", description: "Stop all running agents" },
      ];
      return items.filter((item) => item.value.startsWith(argumentPrefix));
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify(USAGE, "info");
        return;
      }

      if (trimmed === "stop") {
        const hadConnections = connections.size > 0;
        disposeAll();
        ctx.ui.notify(hadConnections ? "ACP agents stopped." : "No ACP agents running.", "info");
        return;
      }

      if (trimmed === "view" || trimmed.startsWith("view ")) {
        const filter = trimmed.slice(4).trim();
        await openSessionViewer(ctx, runs, isAcpAgentId(filter) ? filter : undefined);
        return;
      }

      let rest = trimmed;
      let reset = false;
      if (rest === "new" || rest.startsWith("new ")) {
        reset = true;
        rest = rest.slice(3).trim();
      }

      const [agentToken = "", ...promptParts] = rest.split(/\s+/);
      const prompt = promptParts.join(" ").trim();
      if (!isAcpAgentId(agentToken) || !prompt) {
        ctx.ui.notify(USAGE, "warning");
        return;
      }

      runCommandPrompt(agentToken, prompt, reset, ctx);
    },
  });

  function runCommandPrompt(
    agent: AcpAgentId,
    prompt: string,
    reset: boolean,
    ctx: ExtensionCommandContext,
  ): void {
    if (commandRuns.has(agent)) {
      ctx.ui.notify(`A /acp ${agent} run is already active.`, "warning");
      return;
    }

    const statusKey = `0-acp-${agent}`;
    const controller = new AbortController();
    commandRuns.set(agent, controller);

    const run = runs.create(agent, "command", prompt);
    const { recorder } = run;
    let frame = 0;
    const statusTimer = ctx.hasUI
      ? setInterval(() => {
          frame = (frame + 1) % STATUS_SPINNER_FRAMES.length;
          const spinner = STATUS_SPINNER_FRAMES[frame];
          ctx.ui.setStatus(statusKey, `${spinner} ${agent}: ${recorder.progressLabel} (/acp view)`);
        }, STATUS_SPINNER_INTERVAL_MS)
      : null;

    void (async () => {
      try {
        const connection = getOrCreateConnection(agent);

        let sessionId = reset ? undefined : commandSessions.get(agent);
        if (sessionId && !connection.hasSession(sessionId)) sessionId = undefined;
        if (!sessionId) {
          sessionId = await connection.newSession(ctx.cwd);
          commandSessions.set(agent, sessionId);
        }
        run.sessionId = sessionId;

        const response = await connection.prompt(
          sessionId,
          prompt,
          {
            onUpdate: (update) => {
              recorder.handleUpdate(update);
              run.notify();
            },
            requestPermission: (request) => resolvePermission(ctx, run, request),
          },
          controller.signal,
        );

        if (controller.signal.aborted) return;
        run.finish("done");

        const answer = recorder.finalText || "(no response)";
        const details: AcpMessageDetails = {
          agent,
          prompt,
          sessionId,
          stopReason: response.stopReason,
          entries: recorder.entries,
        };
        pi.sendMessage<AcpMessageDetails>({
          customType: CUSTOM_MESSAGE_TYPE,
          content: `${ACP_AGENT_LABELS[agent]} (via ACP) replied to "${prompt}":\n\n${answer}`,
          display: true,
          details,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        run.finish("error", message);
        ctx.ui.notify(`/acp ${agent}: ${message}`, "error");
      } finally {
        if (run.status === "running") run.finish(controller.signal.aborted ? "done" : "error");
        runs.remove(run);
        if (statusTimer) clearInterval(statusTimer);
        if (ctx.hasUI) ctx.ui.setStatus(statusKey, undefined);
        commandRuns.delete(agent);
      }
    })();
  }

  pi.registerMessageRenderer<AcpMessageDetails>(CUSTOM_MESSAGE_TYPE, (message, _options, theme) => {
    const details = message.details;
    if (!details) return undefined;

    const finalMessage = details.entries.findLast((entry) => entry.kind === "message");
    const answer = finalMessage?.kind === "message" ? finalMessage.text.trim() : "(no response)";

    const container = new Container();
    container.addChild(
      new Text(
        `${theme.fg("customMessageLabel", theme.bold(`${ACP_AGENT_LABELS[details.agent]} (ACP)`))} ${theme.fg("dim", details.prompt)}`,
        0,
        0,
      ),
    );
    container.addChild(new Spacer(1));
    container.addChild(new Markdown(answer, 0, 0, getMarkdownTheme()));
    return container;
  });

  pi.on("session_start", () => disposeAll());
  pi.on("session_shutdown", () => disposeAll());
}

async function resolvePermission(
  ctx: ExtensionContext,
  run: AcpRun,
  request: RequestPermissionRequest,
): Promise<RequestPermissionResponse> {
  const title = request.toolCall.title?.trim() || "a tool call";
  const fallback =
    request.options.find((option) => option.kind === "reject_once") ?? request.options[0];

  if (!ctx.hasUI) {
    return concludePermission(run, title, fallback, "auto-rejected (no UI)");
  }

  const labels = request.options.map((option) => option.name);
  const choice = await ctx.ui.select(
    `${ACP_AGENT_LABELS[run.agent]} requests permission: ${title}`,
    labels,
  );
  if (choice === undefined) {
    return concludePermission(run, title, fallback, "dismissed");
  }

  const selected = request.options[labels.indexOf(choice)];
  return concludePermission(run, title, selected, selected?.name ?? choice);
}

function concludePermission(
  run: AcpRun,
  title: string,
  option: PermissionOption | undefined,
  decision: string,
): RequestPermissionResponse {
  run.recorder.recordPermission(title, decision);
  run.notify();
  if (!option) return { outcome: { outcome: "cancelled" } };
  return { outcome: { outcome: "selected", optionId: option.optionId } };
}

async function openSessionViewer(
  ctx: ExtensionCommandContext,
  runs: AcpRunRegistry,
  agentFilter: AcpAgentId | undefined,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/acp view requires interactive mode.", "error");
    return;
  }

  const candidates = runs.running().filter((run) => !agentFilter || run.agent === agentFilter);
  if (!candidates.length) {
    const scope = agentFilter ? `${agentFilter} ` : "";
    ctx.ui.notify(`No running ${scope}ACP sessions.`, "info");
    return;
  }

  let run = candidates[0];
  if (candidates.length > 1) {
    const labels = candidates.map((candidate) => {
      const preview = candidate.prompt.replace(/\s+/g, " ").trim().slice(0, 60);
      return `${ACP_AGENT_LABELS[candidate.agent]} · ${preview}`;
    });
    const choice = await ctx.ui.select("View which ACP session?", labels);
    if (choice === undefined) return;
    run = candidates[labels.indexOf(choice)]!;
  }

  const selected = run!;
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => new AcpSessionViewer(selected, tui, theme, done),
  );
}
