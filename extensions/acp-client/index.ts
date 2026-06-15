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
 * Multiple sessions can run concurrently. Each is identified by a short handle
 * like "claude-1" or "codex-2"; prompting an agent name starts a new session,
 * prompting a handle continues that one.
 *
 * Commands:
 * - /acp <claude|codex> <prompt>   start a new session and prompt it
 * - /acp <handle> <prompt>   continue an existing session (e.g. /acp claude-2 ...)
 * - /acp view [handle|agent]   tail a running session's transcript live
 * - /acp stop [handle]   stop one session, or all sessions and processes
 *
 * One agent process is spawned lazily per agent kind via `npx` adapters and
 * hosts all of that agent's sessions for the lifetime of the Pi session.
 * Launch commands can be overridden in ~/.pi/acp.json:
 * { "agents": { "claude": { "command": "...", "args": [...] } } }
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
const USAGE =
  "Usage: /acp <claude|codex|handle> <prompt>, /acp view [handle|agent], /acp stop [handle]";

/** A named, continuable ACP conversation hosted by an agent connection. */
interface ManagedSession {
  handle: string;
  agent: AcpAgentId;
  sessionId: string;
}

/** A resolved /acp prompt target: either a new session or an existing one. */
interface CommandTarget {
  agent: AcpAgentId;
  handle: string;
  sessionId?: string;
}

export default function acpExtension(pi: ExtensionAPI): void {
  const connections = new Map<AcpAgentId, AcpConnection>();
  const sessions = new Map<string, ManagedSession>();
  const sessionCounters = new Map<AcpAgentId, number>();
  const commandRuns = new Map<string, AbortController>();
  const runs = new AcpRunRegistry();

  function getOrCreateConnection(agent: AcpAgentId): AcpConnection {
    let connection = connections.get(agent);
    if (connection && !connection.alive) {
      connection.dispose();
      connections.delete(agent);
      for (const session of sessions.values()) {
        if (session.agent === agent) sessions.delete(session.handle);
      }
      connection = undefined;
    }
    if (!connection) {
      connection = new AcpConnection(agent, loadConfig().agents[agent]);
      connections.set(agent, connection);
    }
    return connection;
  }

  function nextHandle(agent: AcpAgentId): string {
    const count = (sessionCounters.get(agent) ?? 0) + 1;
    sessionCounters.set(agent, count);
    return `${agent}-${count}`;
  }

  function resolveTarget(token: string): CommandTarget | undefined {
    if (isAcpAgentId(token)) {
      return { agent: token, handle: nextHandle(token) };
    }
    const session = sessions.get(token);
    if (session) {
      return { agent: session.agent, handle: session.handle, sessionId: session.sessionId };
    }
    return undefined;
  }

  function disposeAll(): void {
    for (const controller of commandRuns.values()) controller.abort();
    commandRuns.clear();
    for (const connection of connections.values()) connection.dispose();
    connections.clear();
    sessions.clear();
  }

  function stopSession(handle: string): boolean {
    const controller = commandRuns.get(handle);
    const known = controller !== undefined || sessions.has(handle);
    controller?.abort();
    sessions.delete(handle);
    return known;
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
        { value: "claude ", label: "claude", description: "Start a new Claude session" },
        { value: "codex ", label: "codex", description: "Start a new Codex session" },
        { value: "view", label: "view", description: "Tail a running session's transcript" },
        { value: "stop", label: "stop", description: "Stop one session, or all" },
        ...[...sessions.keys()].map((handle) => ({
          value: `${handle} `,
          label: handle,
          description: "Continue this session",
        })),
      ];
      return items.filter((item) => item.value.startsWith(argumentPrefix));
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify(USAGE, "info");
        return;
      }

      const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
      const keyword = match?.[1] ?? trimmed;
      const rest = match?.[2]?.trim() ?? "";

      if (keyword === "stop") {
        if (!rest) {
          const hadConnections = connections.size > 0;
          disposeAll();
          ctx.ui.notify(hadConnections ? "ACP agents stopped." : "No ACP agents running.", "info");
          return;
        }
        ctx.ui.notify(stopSession(rest) ? `Stopped ${rest}.` : `No such session: ${rest}`, "info");
        return;
      }

      if (keyword === "view") {
        await openSessionViewer(ctx, runs, rest || undefined);
        return;
      }

      const target = resolveTarget(keyword);
      if (!target) {
        ctx.ui.notify(`Unknown agent or session "${keyword}". ${USAGE}`, "warning");
        return;
      }
      if (!rest) {
        ctx.ui.notify(`Provide a prompt. ${USAGE}`, "warning");
        return;
      }

      startCommandRun(target, rest, ctx);
    },
  });

  function startCommandRun(
    target: CommandTarget,
    prompt: string,
    ctx: ExtensionCommandContext,
  ): void {
    const { agent, handle } = target;
    if (commandRuns.has(handle)) {
      ctx.ui.notify(`Session ${handle} is already processing a prompt.`, "warning");
      return;
    }

    const statusKey = `0-acp-${handle}`;
    const controller = new AbortController();
    commandRuns.set(handle, controller);

    const run = runs.create(agent, "command", prompt, handle);
    const { recorder } = run;
    let frame = 0;
    const statusTimer = ctx.hasUI
      ? setInterval(() => {
          frame = (frame + 1) % STATUS_SPINNER_FRAMES.length;
          const spinner = STATUS_SPINNER_FRAMES[frame];
          ctx.ui.setStatus(
            statusKey,
            `${spinner} ${handle}: ${recorder.progressLabel} (/acp view ${handle})`,
          );
        }, STATUS_SPINNER_INTERVAL_MS)
      : null;

    void (async () => {
      try {
        const connection = getOrCreateConnection(agent);

        let sessionId = target.sessionId;
        if (sessionId && !connection.hasSession(sessionId)) sessionId = undefined;
        if (!sessionId) {
          sessionId = await connection.newSession(ctx.cwd);
        }
        run.sessionId = sessionId;
        sessions.set(handle, { handle, agent, sessionId });

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
          handle,
          prompt,
          sessionId,
          stopReason: response.stopReason,
          entries: recorder.entries,
        };
        pi.sendMessage<AcpMessageDetails>({
          customType: CUSTOM_MESSAGE_TYPE,
          content: `${ACP_AGENT_LABELS[agent]} (${handle}) replied to "${prompt}":\n\n${answer}`,
          display: true,
          details,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        run.finish("error", message);
        ctx.ui.notify(`/acp ${handle}: ${message}`, "error");
      } finally {
        if (run.status === "running") run.finish(controller.signal.aborted ? "done" : "error");
        runs.remove(run);
        if (statusTimer) clearInterval(statusTimer);
        if (ctx.hasUI) ctx.ui.setStatus(statusKey, undefined);
        commandRuns.delete(handle);
      }
    })();
  }

  pi.registerMessageRenderer<AcpMessageDetails>(CUSTOM_MESSAGE_TYPE, (message, _options, theme) => {
    const details = message.details;
    if (!details) return undefined;

    const finalMessage = details.entries.findLast((entry) => entry.kind === "message");
    const answer = finalMessage?.kind === "message" ? finalMessage.text.trim() : "(no response)";

    const label = `${ACP_AGENT_LABELS[details.agent]} · ${details.handle}`;
    const container = new Container();
    container.addChild(
      new Text(
        `${theme.fg("customMessageLabel", theme.bold(label))} ${theme.fg("dim", details.prompt)}`,
        0,
        0,
      ),
    );
    container.addChild(new Spacer(1));
    container.addChild(new Markdown(answer, 0, 0, getMarkdownTheme()));
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", `Continue with /acp ${details.handle}`), 0, 0));
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
  filter: string | undefined,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/acp view requires interactive mode.", "error");
    return;
  }

  const candidates = runs
    .running()
    .filter((run) => !filter || run.label === filter || run.agent === filter);
  if (!candidates.length) {
    const scope = filter ? `${filter} ` : "";
    ctx.ui.notify(`No running ${scope}ACP sessions.`, "info");
    return;
  }

  let run = candidates[0];
  if (candidates.length > 1) {
    const labels = candidates.map((candidate) => {
      const name = candidate.label ?? ACP_AGENT_LABELS[candidate.agent];
      const preview = candidate.prompt.replace(/\s+/g, " ").trim().slice(0, 60);
      return `${name} · ${preview}`;
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
