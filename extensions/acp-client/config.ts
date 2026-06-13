import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { AcpAgentId, AcpAgentLaunchConfig, AcpConfig } from "./types.js";

const ACP_CONFIG_PATH = path.join(homedir(), ".pi", "acp.json");

export const ACP_AGENT_IDS = ["claude", "codex"] as const;

export const ACP_AGENT_LABELS: Record<AcpAgentId, string> = {
  claude: "Claude",
  codex: "Codex",
};

export const ACP_AUTH_GUIDANCE: Record<AcpAgentId, string> = {
  claude: "Log in with the Claude CLI (`claude /login`) or set ANTHROPIC_API_KEY.",
  codex: "Log in with the Codex CLI (`codex login`) or set OPENAI_API_KEY.",
};

const DEFAULT_AGENTS: Record<AcpAgentId, AcpAgentLaunchConfig> = {
  claude: { command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp"] },
  codex: { command: "npx", args: ["-y", "@zed-industries/codex-acp"] },
};

export function isAcpAgentId(value: string): value is AcpAgentId {
  return (ACP_AGENT_IDS as readonly string[]).includes(value);
}

export function loadConfig(): AcpConfig {
  let raw: Record<string, unknown> = {};

  try {
    raw = JSON.parse(readFileSync(ACP_CONFIG_PATH, "utf8")) as Record<string, unknown>;
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : undefined;
    if (code !== "ENOENT") {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid ACP config at ${ACP_CONFIG_PATH}: ${message}`);
    }
  }

  const overrides =
    raw.agents && typeof raw.agents === "object" ? (raw.agents as Record<string, unknown>) : {};

  const agents = {} as Record<AcpAgentId, AcpAgentLaunchConfig>;
  for (const agentId of ACP_AGENT_IDS) {
    agents[agentId] = sanitizeLaunchConfig(agentId, overrides[agentId]);
  }

  return { agents };
}

function sanitizeLaunchConfig(agentId: AcpAgentId, value: unknown): AcpAgentLaunchConfig {
  const defaults = DEFAULT_AGENTS[agentId];
  if (!value || typeof value !== "object") {
    return { command: defaults.command, args: [...defaults.args] };
  }

  const raw = value as Record<string, unknown>;
  const command = typeof raw.command === "string" && raw.command.trim() ? raw.command : undefined;
  const args = Array.isArray(raw.args)
    ? raw.args.filter((arg): arg is string => typeof arg === "string")
    : undefined;
  const env =
    raw.env && typeof raw.env === "object"
      ? Object.fromEntries(
          Object.entries(raw.env as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : undefined;

  if (command === undefined && args !== undefined) {
    throw new Error(
      `Invalid ACP config at ${ACP_CONFIG_PATH}: agents.${agentId}.args requires agents.${agentId}.command`,
    );
  }

  return {
    command: command ?? defaults.command,
    args: args ?? (command ? [] : [...defaults.args]),
    env,
  };
}
