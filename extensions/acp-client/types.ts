import type {
  PlanEntryStatus,
  StopReason,
  ToolCallStatus,
  ToolKind,
} from "@agentclientprotocol/sdk";

export type AcpAgentId = "claude" | "codex";

/** How to launch an ACP agent subprocess. */
export interface AcpAgentLaunchConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface AcpConfig {
  agents: Record<AcpAgentId, AcpAgentLaunchConfig>;
}

/** One rendered/recorded item of an agent's prompt turn. */
export type AcpTranscriptEntry =
  | { kind: "message"; text: string }
  | { kind: "thought"; text: string }
  | {
      kind: "tool";
      toolCallId: string;
      title: string;
      toolKind?: ToolKind;
      status: ToolCallStatus;
    }
  | { kind: "plan"; entries: { content: string; status: PlanEntryStatus }[] }
  | { kind: "permission"; title: string; decision: string };

/** Structured details attached to acp_agent tool results. */
export interface AcpToolDetails {
  agent: AcpAgentId;
  sessionId?: string;
  stopReason?: StopReason;
  entries: AcpTranscriptEntry[];
}

/** Details payload for /acp custom messages. */
export interface AcpMessageDetails {
  agent: AcpAgentId;
  prompt: string;
  sessionId: string;
  stopReason: StopReason;
  entries: AcpTranscriptEntry[];
}
