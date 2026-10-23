import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { create, toBinary } from "@bufbuild/protobuf";
import { encodeEnvelope } from "../src/devin.js";
import {
  GetCascadeModelConfigsResponseSchema,
  GetChatMessageResponseSchema,
  type GetChatMessageResponse,
} from "../src/gen/exa/api_server_pb/api_server_pb.js";
import { StopReason as PbStopReason } from "../src/gen/exa/codeium_common_pb/codeium_common_pb.js";

const testEnv = env as unknown as Record<string, string>;

function chatUpstream(): Response {
  const frame = (init: Partial<GetChatMessageResponse>) =>
    encodeEnvelope(toBinary(GetChatMessageResponseSchema, create(GetChatMessageResponseSchema, init as never)));
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(frame({ messageId: "resp-1", deltaText: "Hello" }));
        c.enqueue(frame({ deltaText: " world", stopReason: PbStopReason.UNSPECIFIED }));
        c.enqueue(encodeEnvelope(new TextEncoder().encode("{}"), 0x02));
        c.close();
      },
    }),
    { status: 200 },
  );
}

function modelsUpstream(): Response {
  return new Response(
    toBinary(
      GetCascadeModelConfigsResponseSchema,
      create(GetCascadeModelConfigsResponseSchema, {
        clientModelConfigs: [
          { modelUid: "m1", label: "M1", supportsImages: true },
          { modelUid: "m2", label: "M2", disabled: true },
        ] as never,
      }),
    ),
    { status: 200 },
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
  testEnv.DEVIN_TOKEN = "tok";
  testEnv.DEVIN_BASE_URL = "http://up";
  testEnv.DEVIN_MODEL = "";
  delete testEnv.API_KEY;
  delete testEnv.DASHBOARD_PASSWORD;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/GetChatMessage")) return chatUpstream();
    if (url.endsWith("/GetCascadeModelConfigs")) return modelsUpstream();
    if (url.endsWith("/GetUserStatus")) {
      return new Response(JSON.stringify({ userStatus: { name: "n", email: "e@x", pro: true } }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  SELF.fetch(`http://t${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("worker routes", () => {
  it("GET /healthz", async () => {
    const res = await SELF.fetch("http://t/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"status":"ok"');
  });

  it("POST /v1/chat/completions non-stream returns chat.completion", async () => {
    const res = await post("/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { object: string; choices: { message: { content: string } }[] };
    expect(j.object).toBe("chat.completion");
    expect(j.choices[0]!.message.content).toBe("Hello world");
  });

  it("POST /v1/chat/completions stream returns SSE", async () => {
    const res = await post("/v1/chat/completions", {
      model: "m",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain('"chat.completion.chunk"');
    expect(text).toContain("Hello");
    expect(text).toContain("data: [DONE]");
    expect(text).toContain('"usage"');
  });

  it("POST /v1/messages returns anthropic message", async () => {
    const res = await post("/v1/messages", { model: "m", max_tokens: 100, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { type: string; content: { type: string; text: string }[] };
    expect(j.type).toBe("message");
    expect(j.content[0]).toEqual({ type: "text", text: "Hello world" });
  });

  it("POST /v1/messages stream returns anthropic SSE", async () => {
    const res = await post("/v1/messages", {
      model: "m",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    const text = await res.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: content_block_delta");
    expect(text).toContain("event: message_stop");
  });

  it("POST /v1/responses returns response object", async () => {
    const res = await post("/v1/responses", { model: "m", input: "hi" });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { object: string; id: string; output_text?: string };
    expect(j.object).toBe("response");
    expect(j.id).toMatch(/^resp_/);
  });

  it("POST /v1/responses stream returns SSE lifecycle", async () => {
    const res = await post("/v1/responses", { model: "m", input: "hi", stream: true });
    const text = await res.text();
    expect(text).toContain("event: response.created");
    expect(text).toContain("event: response.completed");
  });

  it("400 on malformed request; 404 on unknown v1 route", async () => {
    const bad = await post("/v1/chat/completions", { messages: [] });
    expect(bad.status).toBe(400);
    const notFound = await SELF.fetch("http://t/v1/nope", { method: "POST" });
    expect(notFound.status).toBe(404);
  });

  it("503 when DEVIN_TOKEN missing", async () => {
    delete testEnv.DEVIN_TOKEN;
    const res = await post("/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(503);
  });
});

describe("API key auth", () => {
  it("rejects missing/invalid key, accepts Bearer and X-Api-Key", async () => {
    testEnv.API_KEY = "secret";
    const noKey = await post("/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(noKey.status).toBe(401);
    const badKey = await post("/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] }, {
      Authorization: "Bearer wrong",
    });
    expect(badKey.status).toBe(401);
    const bearer = await post("/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] }, {
      Authorization: "Bearer secret",
    });
    expect(bearer.status).toBe(200);
    const xkey = await post("/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] }, {
      "X-Api-Key": "secret",
    });
    expect(xkey.status).toBe(200);
  });
});

describe("models + panel", () => {
  it("GET /v1/models + /v1/models/{id}", async () => {
    const res = await SELF.fetch("http://t/v1/models");
    expect(res.status).toBe(200);
    const j = (await res.json()) as { object: string; data: { id: string }[] };
    expect(j.object).toBe("list");
    expect(j.data.map((m) => m.id)).toContain("m1");
    const one = await SELF.fetch("http://t/v1/models/m1");
    expect(one.status).toBe(200);
    const missing = await SELF.fetch("http://t/v1/models/nope");
    expect(missing.status).toBe(404);
  });

  it("GET /panel serves HTML; login flow enforces password", async () => {
    const open = await SELF.fetch("http://t/panel");
    expect(open.status).toBe(200);
    expect(await open.text()).toContain("Devin API");

    testEnv.DASHBOARD_PASSWORD = "pw";
    const gated = await SELF.fetch("http://t/panel");
    expect((await gated.text()).length).toBeGreaterThan(0);
    const apiNoAuth = await SELF.fetch("http://t/panel/api/status");
    expect(apiNoAuth.status).toBe(401);
    const login = await SELF.fetch("http://t/panel/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "password=pw",
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("devin_panel_session=");
    const api = await SELF.fetch("http://t/panel/api/status", { headers: { Cookie: cookie.split(";")[0]! } });
    expect(api.status).toBe(200);
    const status = (await api.json()) as { user: { name: string } };
    expect(status.user.name).toBe("n");
    const models = await SELF.fetch("http://t/panel/api/models", { headers: { Cookie: cookie.split(";")[0]! } });
    expect(models.status).toBe(200);
  });
});

describe("websocket route", () => {
  it("GET /v1/responses without Upgrade returns 405", async () => {
    const res = await SELF.fetch("http://t/v1/responses");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});

describe("body limits", () => {
  it("rejects oversized body without content-length", async () => {
    // Chunked/unknown length: the size check must still apply.
    const chunks = new ReadableStream<Uint8Array>({
      start(c) {
        const head = new TextEncoder().encode('{"model":"m","messages":[{"role":"user","content":"');
        c.enqueue(head);
        const pad = new Uint8Array(33 << 20).fill(0x61); // 33 MiB > 32 MiB limit
        c.enqueue(pad);
        c.enqueue(new TextEncoder().encode('"}]}'));
        c.close();
      },
    });
    const res = await SELF.fetch("http://t/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: chunks,
      // @ts-expect-error duplex required for streaming bodies
      duplex: "half",
    });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: { message: string } };
    expect(j.error.message).toMatch(/exceeds/);
  });

  it("honors MAX_BODY_BYTES override", async () => {
    testEnv.MAX_BODY_BYTES = "1024";
    const res = await post("/v1/chat/completions", {
      model: "m",
      messages: [{ role: "user", content: "x".repeat(2000) }],
    });
    expect(res.status).toBe(400);
    delete testEnv.MAX_BODY_BYTES;
  });
});
