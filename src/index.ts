// Worker entry — routes, auth, concurrency, SSE pipeline.
// Port of internal/app/app.go + websocket.go.

import { DevinAdapter } from "./devin.js";
import { openAIErrorType } from "./common.js";
import { emptyUsage, type AssistantMessage, type ResponseEvent } from "./llm.js";
import * as responsesProtocol from "./responses.js";
import * as chatProtocol from "./chat.js";
import * as anthropicProtocol from "./messages.js";
import { dashboard } from "./dashboard.js";

export type Env = {
  DEVIN_BASE_URL?: string;
  DEVIN_MODEL?: string;
  DEBUG?: string;
  DEVIN_TOKEN?: string;
  API_KEY?: string;
  DASHBOARD_PASSWORD?: string;
  MAX_CONCURRENCY?: string;
};

const DEFAULT_MAX_CONCURRENCY = 1024;
const BODY_LIMIT = 32 << 20;
const WS_PROTOCOL = "responses_websockets=2026-02-06";

// Per-isolate state.
let inflight = 0;
let adapter: DevinAdapter | undefined;
let adapterKey = "";

function getAdapter(env: Env): DevinAdapter | undefined {
  const token = env.DEVIN_TOKEN?.trim() ?? "";
  if (token === "") return undefined;
  const key = `${env.DEVIN_BASE_URL ?? ""}${token}${env.DEVIN_MODEL ?? ""}`;
  if (!adapter || adapterKey !== key) {
    adapter = new DevinAdapter({
      baseUrl: env.DEVIN_BASE_URL?.trim() || "https://server.codeium.com",
      token,
      model: env.DEVIN_MODEL ?? "",
    });
    adapterKey = key;
  }
  return adapter;
}

function debug(env: Env, stage: string, payload: unknown): void {
  if (env.DEBUG !== "true" && env.DEBUG !== "1") return;
  try {
    console.log(JSON.stringify({ stage, payload }));
  } catch {
    /* ignore */
  }
}

function jsonError(status: number, message: string, type = "invalid_request_error"): Response {
  return Response.json({ error: { message, type, code: null, param: null } }, { status });
}

function mapProviderErrorStatus(message: string): number {
  if (
    message.includes("does not support image") ||
    message.includes("invalid_argument") ||
    message.includes("file_id images") ||
    message.includes("only data URL") ||
    message.includes("validate Devin request") ||
    message.includes("validate adapted request")
  ) {
    return 400;
  }
  if (message.includes("unauthenticated")) return 401;
  if (message.includes("permission_denied")) return 403;
  if (message.includes("not_found")) return 404;
  if (message.includes("resource_exhausted")) return 429;
  return 502;
}

function loggedError(env: Env, stage: string, status: number, err: Error): Response {
  debug(env, stage, err.message);
  const message = err.message;
  let errorType = openAIErrorType(message);
  if (
    status === 400 ||
    message.includes("does not support image") ||
    message.includes("invalid_argument")
  ) {
    errorType = "invalid_request_error";
    if (status >= 500) status = 400;
  }
  return jsonError(status, message, errorType);
}

async function sha256hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function checkAPIKey(request: Request, env: Env): Promise<Response | null> {
  const expected = env.API_KEY?.trim() ?? "";
  if (expected === "") return null;
  let provided = "";
  const auth = request.headers.get("Authorization") ?? "";
  if (auth.startsWith("Bearer ")) provided = auth.slice(7).trim();
  if (provided === "") provided = (request.headers.get("X-Api-Key") ?? "").trim();
  if (provided === "") return jsonError(401, "Missing API key");
  const [expHash, gotHash] = await Promise.all([sha256hex(expected), sha256hex(provided)]);
  if (expHash !== gotHash) return jsonError(401, "Invalid API key");
  return null;
}

// ---- protocol plumbing ----

type ProtocolOpts = { stream: boolean; includeUsage: boolean };
type Protocol = {
  decode: (body: string) => { context: import("./llm.js").RequestMessages; options: ProtocolOpts };
  newStreamEncoder: (model: string, includeUsage: boolean) => { encode(e: ResponseEvent): { name: string; data: string }[] };
  encodeFinal: (message: AssistantMessage) => unknown;
  sseFormat: (name: string, data: string) => string;
};

const RESPONSES: Protocol = {
  decode: (b) => {
    const adapted = responsesProtocol.decodeRequest(b);
    return { context: adapted.context, options: { stream: adapted.options.stream, includeUsage: false } };
  },
  newStreamEncoder: (m) => new responsesProtocol.StreamEncoder(m),
  encodeFinal: (m) => responsesProtocol.encodeResponse(m),
  sseFormat: (name, data) => `event: ${name}\ndata: ${data}\n\n`,
};

const CHAT: Protocol = {
  decode: (b) => {
    const adapted = chatProtocol.decodeRequest(b);
    return { context: adapted.context, options: adapted.options };
  },
  newStreamEncoder: (m, includeUsage) => new chatProtocol.StreamEncoder(m, includeUsage),
  encodeFinal: (m) => chatProtocol.encodeResponse(m),
  sseFormat: (name, data) => (name === "[DONE]" ? "data: [DONE]\n\n" : `data: ${data}\n\n`),
};

const ANTHROPIC: Protocol = {
  decode: (b) => {
    const adapted = anthropicProtocol.decodeRequest(b);
    return { context: adapted.context, options: { stream: adapted.options.stream, includeUsage: false } };
  },
  newStreamEncoder: (m) => new anthropicProtocol.StreamEncoder(m),
  encodeFinal: (m) => anthropicProtocol.encodeResponse(m),
  sseFormat: (name, data) => `event: ${name}\ndata: ${data}\n\n`,
};

function eventMessage(event: ResponseEvent, fallback: AssistantMessage | undefined): AssistantMessage | undefined {
  return event.message ?? event.error ?? event.partial ?? fallback;
}

async function createCompletion(request: Request, env: Env, protocol: Protocol): Promise<Response> {
  const devin = getAdapter(env);
  if (!devin) return jsonError(503, "provider adapter is not configured (set DEVIN_TOKEN)");

  let body: string;
  try {
    body = await readBodyLimited(request);
  } catch (e) {
    return loggedError(env, "http_read", 400, e as Error);
  }
  let adapted: { context: import("./llm.js").RequestMessages; options: ProtocolOpts };
  try {
    adapted = protocol.decode(body);
  } catch (e) {
    return loggedError(env, "http_decode", 400, e as Error);
  }
  const { context, options } = adapted;
  debug(env, "request", context);

  let stream: AsyncGenerator<ResponseEvent>;
  try {
    stream = devin.stream(context);
  } catch (e) {
    return loggedError(env, "provider_stream", mapProviderErrorStatus((e as Error).message), e as Error);
  }

  if (options.stream) {
    // Peek the first event so immediate upstream errors map to a proper HTTP status.
    let first: IteratorResult<ResponseEvent>;
    try {
      first = await stream.next();
    } catch (e) {
      return loggedError(env, "provider_stream", mapProviderErrorStatus((e as Error).message), e as Error);
    }
    if (first.done) {
      // Empty stream — emit headers + encoder pipeline anyway (encoders emit start events on first event).
      return jsonError(502, "response stream ended without events");
    }
    if (first.value.type === "error") {
      const message = first.value.error?.errorMessage || "response stream returned an error event immediately";
      return loggedError(env, "provider_stream", mapProviderErrorStatus(message), new Error(message));
    }
    return sseResponse(env, protocol, context.model, options, stream, first.value);
  }

  // Non-stream: collect the final message.
  try {
    const final = await collectFinalMessage(stream);
    return Response.json(protocol.encodeFinal(final));
  } catch (e) {
    return loggedError(env, "provider_stream", mapProviderErrorStatus((e as Error).message), e as Error);
  }
}

async function collectFinalMessage(stream: AsyncGenerator<ResponseEvent>): Promise<AssistantMessage> {
  let final: AssistantMessage | undefined;
  for await (const event of stream) {
    debugEvent(event);
    if (event.type === "done") {
      if (!event.message) throw new Error("done event has no final message");
      final = event.message;
    } else if (event.type === "error") {
      throw new Error(event.error?.errorMessage || "error event has no error message");
    }
  }
  if (!final) throw new Error("response stream ended without a final message");
  return final;
}

function debugEvent(_event: ResponseEvent): void {
  /* recorded at a coarser level via debug() when DEBUG is on */
}

function sseResponse(
  env: Env,
  protocol: Protocol,
  model: string,
  options: ProtocolOpts,
  rest: AsyncGenerator<ResponseEvent>,
  firstEvent: ResponseEvent,
): Response {
  const encoder = protocol.newStreamEncoder(model, options.includeUsage);
  const textEncoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const writeEvent = async (event: ResponseEvent): Promise<string | undefined> => {
    for (const encoded of encoder.encode(event)) {
      await writer.write(textEncoder.encode(protocol.sseFormat(encoded.name, encoded.data)));
      debug(env, "sse", { name: encoded.name, data: encoded.data });
    }
    if (event.type === "error") {
      return event.error?.errorMessage || "response stream returned an error event";
    }
    return undefined;
  };

  const pump = (async () => {
    let streamErr: string | undefined;
    try {
      streamErr = await writeEvent(firstEvent);
      if (!streamErr) {
        for await (const event of rest) {
          streamErr = await writeEvent(event);
          if (streamErr) break;
        }
      }
    } catch (e) {
      streamErr = (e as Error).message;
      // Best effort: surface the failure inside the open stream.
      try {
        await writeEvent({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [],
            model,
            responseModel: "",
            usage: emptyUsage(),
            timestampMS: Date.now(),
            errorMessage: streamErr,
          },
        });
      } catch {
        /* client may be gone */
      }
    } finally {
      if (streamErr) debug(env, "stream_error", streamErr);
      try {
        await writer.close();
      } catch {
        /* already closed */
      }
    }
  })();
  void pump;

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

async function readBodyLimited(request: Request): Promise<string> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > BODY_LIMIT) throw new Error(`request body exceeds ${BODY_LIMIT} bytes`);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > BODY_LIMIT) {
    throw new Error(`request body exceeds ${BODY_LIMIT} bytes`);
  }
  return text;
}

// ---- /v1/models ----

async function listModels(env: Env): Promise<Response> {
  const devin = getAdapter(env);
  if (!devin) return jsonError(503, "provider adapter is not configured");
  let models;
  try {
    models = await devin.listModels();
  } catch (e) {
    return jsonError(502, (e as Error).message);
  }
  const now = Math.floor(Date.now() / 1000);
  return Response.json({
    object: "list",
    data: models.map((m) => ({
      id: m.id,
      object: "model",
      created: m.created || now,
      owned_by: m.ownedBy || "devin",
      supports_images: m.supportsImages,
    })),
  });
}

async function getModel(id: string, env: Env): Promise<Response> {
  const devin = getAdapter(env);
  if (!devin) return jsonError(503, "provider adapter is not configured");
  let models;
  try {
    models = await devin.listModels();
  } catch (e) {
    return jsonError(502, (e as Error).message);
  }
  const now = Math.floor(Date.now() / 1000);
  const m = models.find((x) => x.id === id);
  if (!m) return jsonError(404, `model "${id}" not found`);
  return Response.json({
    id: m.id,
    object: "model",
    created: m.created || now,
    owned_by: m.ownedBy || "devin",
    supports_images: m.supportsImages,
  });
}

// ---- WebSocket for /v1/responses ----

async function responsesWebSocket(request: Request, env: Env): Promise<Response> {
  if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  const send = (data: string) => {
    try {
      server.send(data);
    } catch {
      /* client gone */
    }
  };

  server.addEventListener("message", (msgEvent) => {
    void (async () => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(String(msgEvent.data));
        payload.stream = true;
      } catch {
        server.close(1003, "invalid request payload");
        return;
      }
      const devin = getAdapter(env);
      if (!devin) {
        send(JSON.stringify({ type: "error", message: "provider adapter is not configured" }));
        server.close(1011, "not configured");
        return;
      }
      const encoder = new responsesProtocol.StreamEncoder("");
      try {
        const adapted = responsesProtocol.decodeRequest(JSON.stringify(payload));
        const stream = devin.stream(adapted.context);
        for await (const event of stream) {
          for (const encoded of encoder.encode(event)) {
            send(encoded.data);
          }
          if (event.type === "error") {
            server.close(1011, "stream error");
            return;
          }
        }
        server.close(1000, "");
      } catch (e) {
        send(JSON.stringify({ type: "error", message: (e as Error).message }));
        server.close(1011, "error");
      }
    })();
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: { "Sec-WebSocket-Protocol": WS_PROTOCOL },
  });
}

// ---- routing ----

async function routeV1(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (inflight >= maxConcurrency(env)) {
    return jsonError(503, "server is busy, please try again later");
  }
  inflight++;
  try {
    const authError = await checkAPIKey(request, env);
    if (authError) return authError;

    if (method === "GET" && path === "/v1/models") return await listModels(env);
    if (method === "GET" && path.startsWith("/v1/models/")) {
      return await getModel(decodeURIComponent(path.slice("/v1/models/".length)), env);
    }
    if (path === "/v1/responses") {
      if (method === "GET") return await responsesWebSocket(request, env);
      if (method === "POST") return await createCompletion(request, env, RESPONSES);
    }
    if (method === "POST" && path === "/v1/chat/completions") {
      return await createCompletion(request, env, CHAT);
    }
    if (method === "POST" && path === "/v1/messages") {
      return await createCompletion(request, env, ANTHROPIC);
    }
    return jsonError(404, "Not Found");
  } finally {
    inflight--;
  }
}

function maxConcurrency(env: Env): number {
  const parsed = Number(env.MAX_CONCURRENCY ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CONCURRENCY;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === "GET" && path === "/healthz") {
        return new Response('{"status":"ok"}\n', { headers: { "Content-Type": "application/json" } });
      }
      if (path === "/panel" || path.startsWith("/panel/")) {
        return await dashboard(request, env);
      }
      if (path.startsWith("/v1/")) {
        return await routeV1(request, env);
      }
      return jsonError(404, "Not Found");
    } catch (e) {
      debug(env, "unhandled", (e as Error).message);
      return jsonError(500, "internal error");
    }
  },
};
