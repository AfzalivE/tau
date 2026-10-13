import { isClassifierId } from "../config.js";
import {
  SANDBOX_REVIEW_OUTCOMES,
  validUsage,
  type SandboxReviewHistory,
  type SandboxReviewRequest,
  type SandboxReviewResult,
} from "../classifier.js";

/** The IPC peer supplies evidence, not configuration, user intent, or an authorization decision. */
export function delegatedRequest(value: unknown): SandboxReviewRequest | undefined {
  if (!object(value)) return undefined;
  const kind = (["filesystem", "network", "mach-lookup"] as const).find(
    (kind) => kind === value.kind,
  );
  if (
    !kind ||
    typeof value.cwd !== "string" ||
    typeof value.target !== "string" ||
    typeof value.operation !== "string" ||
    typeof value.retry !== "boolean" ||
    !object(value.permission) ||
    (value.command !== undefined && typeof value.command !== "string") ||
    (value.evidence !== undefined && typeof value.evidence !== "string")
  )
    return undefined;
  return {
    kind,
    cwd: value.cwd,
    target: value.target,
    operation: value.operation,
    permission: value.permission,
    retry: value.retry,
    ...(value.command === undefined ? {} : { command: value.command }),
    ...(value.evidence === undefined ? {} : { evidence: value.evidence }),
  };
}

/** Accept only the child's bounded, attributed text records, never raw Pi messages or hidden content. */
export function delegatedHistory(value: unknown): SandboxReviewHistory | undefined {
  if (
    !object(value) ||
    !Array.isArray(value.entries) ||
    value.entries.length > 20 ||
    typeof value.omittedEarlierEntries !== "number" ||
    !Number.isSafeInteger(value.omittedEarlierEntries) ||
    value.omittedEarlierEntries < 0 ||
    Buffer.byteLength(JSON.stringify(value)) > 4000
  )
    return undefined;
  const entries: Record<string, unknown>[] = [];
  for (const entry of value.entries) {
    if (
      !object(entry) ||
      typeof entry.id !== "string" ||
      !entry.id ||
      entry.id.length > 256 ||
      !["delegation", "assistant", "tool"].includes(String(entry.role)) ||
      Object.keys(entry).some(
        (key) =>
          ![
            "id",
            "role",
            "text",
            "toolCalls",
            "toolCallId",
            "name",
            "isError",
            "nestedCalls",
            "omitted",
          ].includes(key),
      )
    )
      return undefined;
    if (entry.omitted !== undefined) {
      if (
        ![
          "context-edit",
          "incomplete-context",
          "non-text",
          "unsupported-role",
          "invalid-input",
          "input-too-large",
          "sensitive-input",
        ].includes(String(entry.omitted))
      )
        return undefined;
      entries.push({ id: entry.id, role: entry.role, omitted: entry.omitted });
      continue;
    }
    if (typeof entry.text !== "string") return undefined;
    if (
      entry.role === "assistant" &&
      (!Array.isArray(entry.toolCalls) ||
        entry.toolCalls.some(
          (call) =>
            !object(call) ||
            typeof call.id !== "string" ||
            typeof call.name !== "string" ||
            !object(call.arguments) ||
            Object.keys(call).some((key) => !["id", "name", "arguments"].includes(key)),
        ))
    )
      return undefined;
    if (
      entry.role === "tool" &&
      (typeof entry.toolCallId !== "string" ||
        typeof entry.name !== "string" ||
        typeof entry.isError !== "boolean")
    )
      return undefined;
    entries.push(entry);
  }
  return { entries, omittedEarlierEntries: value.omittedEarlierEntries };
}

/** Only a matching, completed approval can become a child's one-use capability. */
export function delegatedResult(value: unknown): SandboxReviewResult {
  const usage = object(value) ? validUsage(value.usage) : undefined;
  const invalid: SandboxReviewResult = {
    diagnostic: {
      outcome: "invalid-response",
      attempted: object(value) && object(value.diagnostic) && value.diagnostic.attempted === true,
    },
    ...(usage ? { usage } : {}),
  };
  if (!object(value) || !object(value.diagnostic)) return invalid;
  const diagnostic = value.diagnostic;
  const outcome = SANDBOX_REVIEW_OUTCOMES.find((outcome) => outcome === diagnostic.outcome);
  const label = (["low", "high", "approve", "escalate"] as const).find(
    (label) => label === diagnostic.label,
  );
  const classifier = isClassifierId(diagnostic.classifier) ? diagnostic.classifier : undefined;
  if (
    !outcome ||
    typeof diagnostic.attempted !== "boolean" ||
    (diagnostic.classifier !== undefined && !classifier) ||
    (diagnostic.label !== undefined && (!label || !diagnostic.attempted)) ||
    (value.usage !== undefined && !usage) ||
    (value.approvedBy !== undefined &&
      (value.approvedBy !== classifier || outcome !== "approved")) ||
    (outcome === "approved" &&
      (!value.approvedBy || !diagnostic.attempted || (label !== "low" && label !== "approve")))
  )
    return invalid;
  return {
    diagnostic: {
      outcome,
      attempted: diagnostic.attempted,
      ...(classifier ? { classifier } : {}),
      ...(label ? { label } : {}),
    },
    ...(value.approvedBy === undefined ? {} : { approvedBy: classifier }),
    ...(usage ? { usage } : {}),
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
