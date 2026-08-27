import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";

export const MAX_INITIAL_HEADER_BYTES = 16 * 1024;
export const MAX_INITIAL_HEADER_COUNT = 100;
const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;
const LOOPBACK_HOST = "127.0.0.1";

export interface SrtProxyTarget {
  port: number;
  authToken: string;
}

interface ActiveSrtProxyTarget {
  port: number;
  authorization: string;
}

/**
 * Session-scoped, unauthenticated loopback proxy for JVM clients. Every
 * accepted request has its proxy credentials replaced and is sent only to
 * SRT's authenticated proxy, which remains the network-policy boundary.
 */
export class JvmProxyAdapter {
  readonly #connections = new Set<Socket>();
  #server: Server | undefined;
  #port: number | undefined;
  #startPromise: Promise<number> | undefined;
  #target: ActiveSrtProxyTarget | undefined;

  get activePort(): number | undefined {
    return this.#target ? this.#port : undefined;
  }

  async start(): Promise<number> {
    if (this.#port !== undefined) return this.#port;
    if (this.#startPromise) return this.#startPromise;

    this.#startPromise = this.#start();
    try {
      return await this.#startPromise;
    } finally {
      this.#startPromise = undefined;
    }
  }

  activate(target: SrtProxyTarget): void {
    if (this.#port === undefined) throw new Error("JVM proxy adapter is not listening");
    if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65_535) {
      throw new Error("SRT proxy port is invalid");
    }
    if (!/^[\u0021-\u007e]+$/u.test(target.authToken)) {
      throw new Error("SRT proxy authentication token is invalid");
    }

    this.#target = {
      port: target.port,
      authorization: createSrtProxyAuthorization(target.authToken),
    };
  }

  suspend(): void {
    this.#target = undefined;
    this.#destroyConnections();
  }

  async close(): Promise<void> {
    this.suspend();

    const server = this.#server;
    this.#server = undefined;
    this.#port = undefined;
    if (!server) return;

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async #start(): Promise<number> {
    const server = createServer({ maxHeaderSize: MAX_INITIAL_HEADER_BYTES }, (request, response) =>
      this.#forwardHttpRequest(request, response),
    );
    // Retain every header within the byte limit so excess header count is
    // rejected below instead of Node silently dropping fields.
    server.maxHeadersCount = 0;
    server.headersTimeout = 10_000;
    server.on("connect", (request, socket, head) =>
      this.#forwardConnectRequest(request, socket, head),
    );
    server.on("connection", (socket) => this.#trackConnection(socket));
    server.on("clientError", (error, socket) => respondToMalformedRequest(error, socket));

    try {
      const port = await listenOnRandomLoopbackPort(server);
      server.unref();
      this.#server = server;
      this.#port = port;
      return port;
    } catch (error) {
      server.close();
      throw error;
    }
  }

  #forwardHttpRequest(request: IncomingMessage, response: ServerResponse): void {
    if (hasTooManyHeaders(request)) {
      respondWithText(response, 431, "Request Header Fields Too Large");
      return;
    }

    const target = this.#target;
    if (!target) {
      respondWithText(response, 503, "Proxy unavailable");
      return;
    }

    const upstreamRequest = httpRequest({
      host: LOOPBACK_HOST,
      port: target.port,
      method: request.method,
      path: request.url,
      headers: buildForwardedHeaders(request.headers, target.authorization),
      agent: false,
    });

    upstreamRequest.on("socket", (socket) => this.#trackConnection(socket));
    upstreamRequest.once("response", (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage,
        upstreamResponse.headers,
      );
      upstreamResponse.pipe(response);
    });
    upstreamRequest.once("error", () => {
      if (!response.headersSent) {
        respondWithText(response, 502, "Bad Gateway");
      } else {
        response.destroy();
      }
    });
    response.once("close", () => upstreamRequest.destroy());
    request.pipe(upstreamRequest);
  }

  #forwardConnectRequest(request: IncomingMessage, client: Duplex, head: Buffer): void {
    if (hasTooManyHeaders(request)) {
      respondToSocket(client, 431, "Request Header Fields Too Large");
      return;
    }

    const target = this.#target;
    if (!target) {
      respondToSocket(client, 503, "Proxy unavailable");
      return;
    }

    client.pause();
    const upstream = connect({ host: LOOPBACK_HOST, port: target.port });
    this.#trackConnection(upstream);

    const connectTimeout = setTimeout(() => {
      upstream.destroy(new Error("SRT proxy connection timed out"));
    }, UPSTREAM_CONNECT_TIMEOUT_MS);
    connectTimeout.unref();

    upstream.once("connect", () => {
      clearTimeout(connectTimeout);
      upstream.write(serializeConnectRequest(request, target.authorization));
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
      client.resume();
    });
    upstream.once("error", () => {
      clearTimeout(connectTimeout);
      if (!client.destroyed) respondToSocket(client, 502, "Bad Gateway");
    });
    client.once("error", () => upstream.destroy());
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
  }

  #trackConnection(socket: Socket): void {
    this.#connections.add(socket);
    socket.once("close", () => this.#connections.delete(socket));
  }

  #destroyConnections(): void {
    for (const socket of this.#connections) socket.destroy();
    this.#connections.clear();
  }
}

export function createSrtProxyAuthorization(authToken: string): string {
  return `Basic ${Buffer.from(`srt:${authToken}`).toString("base64")}`;
}

function listenOnRandomLoopbackPort(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("JVM proxy adapter did not receive a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function hasTooManyHeaders(request: IncomingMessage): boolean {
  return request.rawHeaders.length / 2 > MAX_INITIAL_HEADER_COUNT;
}

function buildForwardedHeaders(
  headers: IncomingHttpHeaders,
  authorization: string,
): IncomingHttpHeaders {
  const forwarded = { ...headers };
  delete forwarded["proxy-authorization"];
  forwarded["proxy-authorization"] = authorization;
  return forwarded;
}

function serializeConnectRequest(request: IncomingMessage, authorization: string): string {
  const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];

  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (!name || value === undefined || name.toLowerCase() === "proxy-authorization") continue;
    lines.push(`${name}: ${value}`);
  }

  lines.push(`Proxy-Authorization: ${authorization}`, "", "");
  return lines.join("\r\n");
}

function respondToMalformedRequest(error: Error, socket: Duplex): void {
  if (socket.destroyed) return;

  const isOversized = (error as NodeJS.ErrnoException).code === "HPE_HEADER_OVERFLOW";
  respondToSocket(
    socket,
    isOversized ? 431 : 400,
    isOversized ? "Request Header Fields Too Large" : "Bad Request",
  );
}

function respondToSocket(socket: Duplex, statusCode: number, message: string): void {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function respondWithText(response: ServerResponse, statusCode: number, message: string): void {
  response.writeHead(statusCode, {
    "content-type": "text/plain",
    "content-length": Buffer.byteLength(message),
    connection: "close",
  });
  response.end(message);
}
