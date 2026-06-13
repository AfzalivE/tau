import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
  type Client,
  type InitializeResponse,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import { ACP_AUTH_GUIDANCE } from "./config.js";
import type { AcpAgentId, AcpAgentLaunchConfig } from "./types.js";

const STDERR_TAIL_LINES = 20;

export interface PromptHandlers {
  onUpdate?: (update: SessionUpdate) => void;
  requestPermission: (params: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
}

interface SessionState {
  handlers?: PromptHandlers;
}

/**
 * One spawned ACP agent subprocess with its client-side protocol connection.
 *
 * Sessions are created against the connection and prompted one at a time per
 * session; concurrent prompts must use separate sessions.
 */
export class AcpConnection {
  private readonly child: ChildProcess;
  private readonly connection: ClientSideConnection;
  private readonly sessions = new Map<string, SessionState>();
  private readonly initialized: Promise<InitializeResponse>;
  private readonly stderrTail: string[] = [];
  private exitDescription: string | undefined;

  constructor(
    readonly agent: AcpAgentId,
    launch: AcpAgentLaunchConfig,
  ) {
    this.child = spawn(launch.command, launch.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...launch.env },
    });
    this.child.on("error", (error) => {
      this.exitDescription ??= `failed to start \`${launch.command}\`: ${error.message}`;
    });
    this.child.on("exit", (code, signal) => {
      this.exitDescription ??= signal
        ? `agent process exited with signal ${signal}`
        : `agent process exited with code ${code}`;
    });
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
      }
    });

    const stream = ndJsonStream(
      Writable.toWeb(this.child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(this.child.stdout!) as ReadableStream<Uint8Array>,
    );
    this.connection = new ClientSideConnection(() => this.createClient(), stream);
    this.initialized = this.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "tau-acp", version: "1" },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
    this.initialized.catch(() => undefined);
  }

  get alive(): boolean {
    return this.exitDescription === undefined && !this.connection.signal.aborted;
  }

  async newSession(cwd: string): Promise<string> {
    try {
      await this.initialized;
      const response = await this.connection.newSession({ cwd, mcpServers: [] });
      this.sessions.set(response.sessionId, {});
      return response.sessionId;
    } catch (error) {
      throw this.describeError(error);
    }
  }

  async prompt(
    sessionId: string,
    text: string,
    handlers: PromptHandlers,
    signal: AbortSignal | undefined,
  ): Promise<PromptResponse> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown ${this.agent} ACP session: ${sessionId}`);
    if (session.handlers) {
      throw new Error(`A prompt is already running in this ${this.agent} session.`);
    }

    session.handlers = handlers;
    const onAbort = () => void this.connection.cancel({ sessionId }).catch(() => undefined);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    try {
      return await this.connection.prompt({
        sessionId,
        prompt: [{ type: "text", text }],
      });
    } catch (error) {
      throw this.describeError(error);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      session.handlers = undefined;
    }
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  dispose(): void {
    this.exitDescription ??= "agent process was stopped";
    this.child.kill("SIGTERM");
  }

  private createClient(): Client {
    return {
      sessionUpdate: async (params) => {
        this.sessions.get(params.sessionId)?.handlers?.onUpdate?.(params.update);
      },
      requestPermission: async (params) => {
        const handlers = this.sessions.get(params.sessionId)?.handlers;
        if (!handlers) return { outcome: { outcome: "cancelled" } };
        return handlers.requestPermission(params);
      },
      readTextFile: async (params) => {
        let content = await fs.readFile(params.path, "utf8");
        if (params.line != null || params.limit != null) {
          const lines = content.split("\n");
          const start = Math.max(0, (params.line ?? 1) - 1);
          const end = params.limit != null ? start + params.limit : lines.length;
          content = lines.slice(start, end).join("\n");
        }
        return { content };
      },
      writeTextFile: async (params) => {
        await fs.mkdir(path.dirname(params.path), { recursive: true });
        await fs.writeFile(params.path, params.content, "utf8");
        return {};
      },
    };
  }

  private describeError(error: unknown): Error {
    if (error instanceof RequestError && error.code === -32000) {
      return new Error(
        `${this.agent} agent requires authentication. ${ACP_AUTH_GUIDANCE[this.agent]}`,
      );
    }

    const message = error instanceof Error ? error.message : String(error);
    const parts = [message];
    if (this.exitDescription) parts.push(this.exitDescription);
    if (this.stderrTail.length) parts.push(`stderr:\n${this.stderrTail.join("\n")}`);
    return new Error(parts.join("\n"));
  }
}
