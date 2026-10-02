export type PromptMode = "interactive" | "non-interactive";

export type SandboxEventOutcome = "blocked" | "allowed";

export interface SandboxEventBase<TKind extends string, TReason extends string> {
  timestamp: number;
  kind: TKind;
  outcome: SandboxEventOutcome;
  reason: TReason;
  target?: string;
  command?: string;
  cwd?: string;
  summary: string;
  suggestedCommand?: string;
}
