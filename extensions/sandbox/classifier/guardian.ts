import { randomUUID } from "node:crypto";
import type { Api, ClassifierContext, Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROVIDER = "openai-codex";
const MODEL = "gpt-5.6-luna";

/** Guardian is a Codex Responses adapter, not a Pi probability-producing classifier. */
export function guardianModel(ctx: ExtensionContext): Model<Api> | undefined {
  const model = ctx.modelRegistry.find(PROVIDER, MODEL);
  return model?.api === "openai-codex-responses" &&
    ctx.modelRegistry.isUsingOAuth(model) &&
    ctx.modelRegistry.getProviderAuthStatus(PROVIDER).configured
    ? model
    : undefined;
}

export async function reviewWithGuardian(
  ctx: ExtensionContext,
  context: ClassifierContext,
  signal: AbortSignal,
  onResponse: (response: { status: number }) => void,
  timeoutMs: number,
): Promise<{ approved: boolean; usage?: Usage }> {
  const model = guardianModel(ctx);
  if (!model || signal.aborted) return { approved: false };
  const sessionId = ctx.sessionManager.getSessionId();
  const threadId = randomUUID();
  const turnId = randomUUID();
  const turnMetadata = JSON.stringify({
    session_id: sessionId,
    thread_id: threadId,
    guardian_classifier_source_thread_id: sessionId,
    turn_id: turnId,
    thread_source: "guardian_classifier",
    turn_trigger: "guardian_classifier",
  });
  const question = context.questions.review;
  const instructions = `${question.instructions}\nReturn exactly low if and only if the approve criterion is satisfied: ${question.type === "choice" ? question.criteria.approve : ""}\nOtherwise return exactly high. No explanation, JSON, probabilities, or tool calls.`;
  const result = await ctx.modelRegistry
    .streamSimple(
      model,
      {
        messages: [
          { role: "system", content: instructions, timestamp: 0 },
          { role: "user", content: JSON.stringify(context.state), timestamp: 0 },
        ],
      },
      {
        signal,
        // SSE is the smallest supported transport. Do not open a cached WebSocket or fall back to another model/provider.
        transport: "sse",
        timeoutMs,
        maxRetries: 0,
        toolChoice: "none",
        cacheRetention: "none",
        headers: {
          "x-codex-guardian": "classifier",
          "x-openai-subagent": "guardian",
          "x-codex-window-id": `${threadId}:0`,
          "x-openai-internal-codex-responses-lite": "true",
          "x-client-request-id": threadId,
          "session-id": sessionId,
          "x-codex-turn-metadata": turnMetadata,
        },
        onResponse,
        onPayload: (payload) => {
          if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
            throw new Error("Invalid Codex payload");
          }
          // Match Codex's tool-less responses-lite request using public payload customization.
          const body = payload as Record<string, unknown>;
          const { instructions: _instructions, text: _text, tools: _tools, ...remaining } = body;
          return {
            ...remaining,
            model: MODEL,
            input: [
              {
                type: "message",
                role: "developer",
                content: [{ type: "input_text", text: instructions }],
              },
              {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: JSON.stringify(context.state) }],
              },
            ],
            store: false,
            stream: true,
            tool_choice: "none",
            parallel_tool_calls: false,
            reasoning: { effort: "low", context: "all_turns" },
            include: [],
            client_metadata: {
              session_id: sessionId,
              thread_id: threadId,
              turn_id: turnId,
              "x-openai-subagent": "guardian",
              "x-codex-window-id": `${threadId}:0`,
              ws_request_header_x_openai_internal_codex_responses_lite: "true",
              "x-codex-turn-metadata": turnMetadata,
            },
          };
        },
      },
    )
    .result();
  const text = result.content.filter((block) => block.type === "text");
  const approved =
    !signal.aborted &&
    result.stopReason === "stop" &&
    result.errorMessage === undefined &&
    result.provider === PROVIDER &&
    result.model === MODEL &&
    // Empty encrypted reasoning envelopes are normal Responses metadata, not extra classifier labels.
    result.content.every(
      (block) => block.type === "text" || (block.type === "thinking" && !block.thinking),
    ) &&
    text.length === 1 &&
    text[0].text === "low";
  // A label is not a probability. Unexpected content, partial output, and empty replies all escalate.
  return { approved, usage: result.usage };
}
