import { TranscriptRecorder } from "./transcript.js";
import type { AcpAgentId } from "./types.js";

export type AcpRunSource = "tool" | "command";
export type AcpRunStatus = "running" | "done" | "error";

/**
 * One in-flight (or just-finished) ACP prompt turn, observable by a live viewer.
 *
 * The transcript recorder accumulates progress as session updates arrive; the
 * run notifies subscribers on every update and on completion so an open viewer
 * can re-render in real time.
 */
export class AcpRun {
  readonly recorder = new TranscriptRecorder();
  readonly startedAt = Date.now();
  status: AcpRunStatus = "running";
  error?: string;
  sessionId?: string;

  private readonly listeners = new Set<() => void>();

  constructor(
    readonly id: string,
    readonly agent: AcpAgentId,
    readonly source: AcpRunSource,
    readonly prompt: string,
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(): void {
    for (const listener of this.listeners) listener();
  }

  finish(status: Exclude<AcpRunStatus, "running">, error?: string): void {
    if (this.status !== "running") return;
    this.status = status;
    this.error = error;
    this.notify();
  }
}

/** Tracks ACP runs that are currently in flight, for the live session viewer. */
export class AcpRunRegistry {
  private readonly runs = new Set<AcpRun>();
  private nextId = 1;

  create(agent: AcpAgentId, source: AcpRunSource, prompt: string): AcpRun {
    const run = new AcpRun(`acp-${this.nextId++}`, agent, source, prompt);
    this.runs.add(run);
    return run;
  }

  remove(run: AcpRun): void {
    this.runs.delete(run);
  }

  running(): AcpRun[] {
    return [...this.runs].filter((run) => run.status === "running");
  }
}
