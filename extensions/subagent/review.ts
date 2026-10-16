import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CHANNEL = "tau:subagent-review";
const MAX_BYTES = 64 * 1024;
const MAX_PENDING = 32;
const MAX_REQUESTS = 4096;
const RECEIPT_TIMEOUT_MS = 30_000;

interface ChildReview {
  request: unknown;
  history?: unknown;
  toolCallId?: string;
  signal: AbortSignal;
  result?: Promise<unknown>;
}

export type ReviewMessage = {
  channel: typeof CHANNEL;
  version: 1;
  id: string;
} & (
  | { type: "request"; request: unknown; history?: unknown; toolCallId?: string }
  | { type: "cancel" | "received" }
  | { type: "result"; result?: unknown }
);

interface ParentReview {
  controller: AbortController;
  completion: Promise<void>;
  received: () => void;
}

/** An ephemeral Node IPC bridge. Neither directions nor replies become conversation entries. */
export function registerChildReviews(pi: ExtensionAPI): void {
  const pending = new Map<string, { resolve: (result: unknown) => void; cancel: () => void }>();
  let active = false;
  let closing: Promise<void> | undefined;

  pi.events.on("subagent:sandbox-review", (data) => {
    const request = data as ChildReview;
    if (!request || !(request.signal instanceof AbortSignal)) return;
    request.result = submit(request);
  });
  pi.on("session_start", async () => {
    await close();
    closing = undefined;
    active = Boolean(process.send && process.connected);
    if (active) {
      process.on("message", receive);
      process.on("disconnect", disconnected);
    }
  });
  pi.on("session_shutdown", close);

  function submit(request: ChildReview): Promise<unknown> {
    if (!active || request.signal.aborted || pending.size >= MAX_PENDING)
      return Promise.resolve(undefined);
    const message: ReviewMessage = {
      channel: CHANNEL,
      version: 1,
      type: "request",
      id: randomUUID(),
      request: request.request,
      ...(request.history === undefined ? {} : { history: request.history }),
      ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
    };
    if (!readReviewMessage(message)) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const cancel = () => {
        void send({ channel: CHANNEL, version: 1, type: "cancel", id: message.id }).catch(() => {
          finish(message.id, undefined);
        });
      };
      pending.set(message.id, {
        cancel,
        resolve: (result) => {
          request.signal.removeEventListener("abort", cancel);
          resolve(result);
        },
      });
      // Cancellation sends a request but still joins the parent's completed result and usage.
      request.signal.addEventListener("abort", cancel, { once: true });
      void send(message).catch(() => finish(message.id, undefined));
    });
  }

  function receive(data: unknown): void {
    const message = readReviewMessage(data);
    if (message?.type !== "result" || !pending.has(message.id)) return;
    finish(message.id, message.result);
    void send({ channel: CHANNEL, version: 1, type: "received", id: message.id }).catch(() => {});
  }

  function finish(id: string, result: unknown): void {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    request.resolve(result);
  }

  function disconnected(): void {
    active = false;
    for (const id of pending.keys()) finish(id, undefined);
  }

  function close(): Promise<void> {
    if (closing) return closing;
    active = false;
    const waiting = [...pending.values()].map(
      (request) =>
        new Promise<void>((resolve) => {
          const complete = request.resolve;
          request.resolve = (result) => {
            complete(result);
            resolve();
          };
          request.cancel();
        }),
    );
    closing = Promise.all(waiting).then(() => {
      process.off("message", receive);
      process.off("disconnect", disconnected);
    });
    return closing;
  }

  function send(message: ReviewMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!process.send || !process.connected) {
        reject(new Error("Subagent review IPC disconnected"));
        return;
      }
      process.send(message, (error) => (error ? reject(error) : resolve()));
    });
  }
}

/** The spawned process supplies identity. Child payloads remain untrusted review data. */
export function createParentReviews(options: {
  pi: ExtensionAPI;
  childId: string;
  context: () => ExtensionContext | undefined;
  signal: AbortSignal;
  send: (message: ReviewMessage) => Promise<void>;
  changed: () => void;
}) {
  // Retain only IDs after completion, so replayed requests cannot start another inference.
  const requests = new Map<string, ParentReview | undefined>();
  let closed = false;
  let disconnected = false;

  function receive(data: unknown): void {
    const message = readReviewMessage(data);
    if (!message) return;
    const pending = requests.get(message.id);
    if (message.type === "cancel") pending?.controller.abort();
    if (message.type === "received") pending?.received();
    if (message.type !== "request" || requests.has(message.id)) return;
    if (
      closed ||
      options.signal.aborted ||
      active() >= MAX_PENDING ||
      requests.size >= MAX_REQUESTS
    ) {
      void reply(message.id, undefined).catch(() => {});
      return;
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, options.signal]);
    let received!: () => void;
    const receipt = new Promise<void>((resolve) => {
      received = resolve;
    });
    const review: ParentReview = { controller, received, completion: Promise.resolve() };
    requests.set(message.id, review);
    options.changed();
    review.completion = Promise.resolve()
      .then(async () => {
        let result: unknown;
        try {
          const ctx = options.context();
          if (ctx && !signal.aborted) {
            const request = {
              ctx,
              childId: options.childId,
              request: message.request,
              history: message.history,
              toolCallId: message.toolCallId,
              signal,
              result: undefined as Promise<unknown> | undefined,
            };
            options.pi.events.emit("sandbox:subagent-review", request);
            result = await request.result;
          }
        } catch {
          // Transport failures never convey provider errors or create approval authority.
        }
        if (disconnected) return;
        await reply(message.id, result);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            receipt,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, RECEIPT_TIMEOUT_MS);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      })
      .catch(() => {})
      .finally(() => {
        requests.set(message.id, undefined);
        options.changed();
      });
  }

  function reply(id: string, result: unknown): Promise<void> {
    const message: ReviewMessage = {
      channel: CHANNEL,
      version: 1,
      type: "result",
      id,
      ...(result === undefined ? {} : { result }),
    };
    return options.send(
      readReviewMessage(message) ? message : { channel: CHANNEL, version: 1, type: "result", id },
    );
  }

  function active(): number {
    return [...requests.values()].filter(Boolean).length;
  }

  function disconnect(): void {
    disconnected = true;
    closed = true;
    for (const request of requests.values()) {
      request?.controller.abort();
      request?.received();
    }
  }

  async function close(): Promise<void> {
    closed = true;
    for (const request of requests.values()) request?.controller.abort();
    await Promise.all([...requests.values()].flatMap((request) => request?.completion ?? []));
  }

  return {
    receive,
    disconnect,
    close,
    get active() {
      return active();
    },
  };
}

/** Validate the envelope and serialization bounds. Sandbox owns the permission/result schemas. */
function readReviewMessage(data: unknown): ReviewMessage | undefined {
  if (!isObject(data) || data.channel !== CHANNEL || data.version !== 1) return undefined;
  if (typeof data.id !== "string" || !/^[\da-f-]{36}$/.test(data.id)) return undefined;
  const fields = ["channel", "version", "id", "type"];
  if (data.type === "request") {
    if (!("request" in data)) return undefined;
    fields.push("request", "history", "toolCallId");
    if (
      data.toolCallId !== undefined &&
      (typeof data.toolCallId !== "string" || !/^[\w.:/|+-]{1,256}$/.test(data.toolCallId))
    )
      return undefined;
  } else if (data.type === "result") fields.push("result");
  else if (data.type !== "cancel" && data.type !== "received") return undefined;
  if (Object.keys(data).some((key) => !fields.includes(key))) return undefined;
  try {
    if (!serializable(data) || Buffer.byteLength(JSON.stringify(data), "utf8") > MAX_BYTES)
      return undefined;
  } catch {
    return undefined;
  }
  return data as ReviewMessage;
}

function serializable(value: unknown, depth = 0): boolean {
  if (depth > 20) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return Buffer.byteLength(value, "utf8") <= MAX_BYTES;
  if (!Array.isArray(value) && !isObject(value)) return false;
  for (const item of Array.isArray(value) ? value : Object.values(value))
    if (!serializable(item, depth + 1)) return false;
  return true;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)),
  );
}
