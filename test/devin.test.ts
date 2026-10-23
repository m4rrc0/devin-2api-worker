import { describe, it, expect } from "vitest";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  DevinAdapter,
  ResponseDecoder,
  buildRequest,
  encodeEnvelope,
  decodeEnvelopes,
  withToolDescriptions,
  formatToolDescription,
  stripSchemaAnnotations,
  modelLikelySupportsImages,
  parseConnectErrorBody,
} from "../src/devin.js";
import { GetChatMessageResponseSchema, type GetChatMessageResponse } from "../src/gen/exa/api_server_pb/api_server_pb.js";
import { StopReason as PbStopReason } from "../src/gen/exa/codeium_common_pb/codeium_common_pb.js";
import { emptyUsage, type RequestMessages, type ResponseEvent } from "../src/llm.js";

const req = (over: Partial<RequestMessages> = {}): RequestMessages => ({
  model: "claude-x",
  systemPrompt: "be brief",
  messages: [
    { role: "user", content: [{ type: "text", text: "hello" }], timestampMS: 1 },
  ],
  tools: [],
  ...over,
});

describe("buildRequest", () => {
  it("fills metadata, configuration, trajectory", () => {
    const r = buildRequest(req(), { baseUrl: "http://x", token: "tok", model: "claude-x" });
    expect(r.metadata?.apiKey).toBe("tok");
    expect(r.metadata?.os).toBe("mac");
    expect(r.metadata?.f).toHaveLength(732);
    expect(r.chatModelUid).toBe("claude-x");
    expect(r.requestType).toBe(5); // CASCADE
    expect(r.configuration?.numCompletions).toBe(1n);
    expect(r.configuration?.maxTokens).toBe(128000n);
    expect(r.trajectoryReference?.trajectoryType).toBe(4);
    expect(r.trajectoryReference?.stepType).toBe(14);
    expect(r.plannerMode).toBe(1);
    expect(r.cascadeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.executionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.chatMessagePrompts).toHaveLength(1);
    expect(r.chatMessagePrompts[0]!.prompt).toBe("hello");
    expect(r.chatMessagePrompts[0]!.source).toBe(1); // USER
  });

  it("attaches images only for the current turn", () => {
    const png = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
    const r = buildRequest(
      req({
        messages: [
          { role: "user", content: [png], timestampMS: 0 },
          { role: "assistant", content: [{ type: "text", text: "ok" }], usage: emptyUsage(), timestampMS: 0 },
          { role: "user", content: [{ type: "text", text: "again" }, png], timestampMS: 0 },
        ],
      }),
      { baseUrl: "http://x", token: "t", model: "m" },
    );
    expect(r.chatMessagePrompts[0]!.images).toHaveLength(0);
    expect(r.chatMessagePrompts[0]!.prompt).toContain("[Image omitted from history]");
    expect(r.chatMessagePrompts[2]!.images).toHaveLength(1);
    expect(r.chatMessagePrompts[2]!.images[0]!.base64Data).toBe("AAAA");
  });

  it("rejects images for known non-vision models", async () => {
    const adapter = new DevinAdapter({ baseUrl: "http://x", token: "t", model: "glm-4.7-x" }, async () => {
      throw new Error("should not fetch");
    });
    const gen = adapter.stream(
      req({ model: "glm-4.7-x", messages: [{ role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }], timestampMS: 0 }] }),
    );
    await expect(gen.next()).rejects.toThrow(/does not support image/);
  });

  it("injects tool descriptions into the system prompt", () => {
    const r = buildRequest(
      req({
        tools: [{ name: "run_tests", description: "Runs the test suite. Reports results.", inputSchema: '{"type":"object"}' }],
      }),
      { baseUrl: "http://x", token: "t", model: "m" },
    );
    expect(r.prompt).toContain("# tools descriptions");
    expect(r.prompt).toContain('<tool name="run_tests">');
    expect(r.prompt).toContain("1. Runs the test suite");
    expect(r.tools[0]!.name).toBe("run_tests");
    expect(r.tools[0]!.description).toBe("run_tests");
    expect(r.tools[0]!.jsonSchemaString).toBe('{"type":"object"}');
  });
});

describe("ResponseDecoder", () => {
  const frame = (init: Partial<GetChatMessageResponse>) =>
    create(GetChatMessageResponseSchema, init as Parameters<typeof create>[1]);

  it("decodes text deltas into a done message", () => {
    const d = new ResponseDecoder("m");
    d.start();
    const e1 = d.decode(frame({ deltaText: "hel" }));
    expect(e1.map((e) => e.type)).toEqual(["text_start", "text_delta"]);
    d.decode(frame({ deltaText: "lo", stopReason: PbStopReason.UNSPECIFIED }));
    const done = d.finish();
    const types = done.map((e) => e.type);
    expect(types).toContain("text_end");
    expect(types[types.length - 1]).toBe("done");
    const message = done.find((e) => e.type === "done")!.message!;
    expect(message.stopReason).toBe("stop");
    expect(message.content[0]).toEqual({ type: "text", text: "hello" });
  });

  it("maps max tokens to length and accumulates usage", () => {
    const d = new ResponseDecoder("m");
    d.start();
    d.decode(frame({ deltaText: "x" }));
    d.decode(
      frame({
        stopReason: PbStopReason.MAX_TOKENS,
        usage: { inputTokens: 5n, outputTokens: 3n, cacheReadTokens: 2n, cacheWriteTokens: 1n, modelUid: "m2" } as never,
      }),
    );
    const done = d.finish();
    const message = done.find((e) => e.type === "done")!.message!;
    expect(message.stopReason).toBe("length");
    expect(message.usage).toMatchObject({ input: 5, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 11 });
    expect(message.responseModel).toBe("m2");
  });

  it("accumulates tool call argument fragments", () => {
    const d = new ResponseDecoder("m");
    d.start();
    d.decode(frame({ deltaToolCalls: [{ id: "c1", name: "read", argumentsJson: '{"a"' }] as never }));
    d.decode(frame({ deltaToolCalls: [{ id: "c1", argumentsJson: ':1}' }] as never, stopReason: PbStopReason.FUNCTION_CALL }));
    const done = d.finish();
    const message = done.find((e) => e.type === "done")!.message!;
    expect(message.stopReason).toBe("toolUse");
    expect(message.content[0]).toMatchObject({ type: "toolCall", id: "c1", name: "read", arguments: '{"a":1}' });
  });

  it("emits thinking blocks then text", () => {
    const d = new ResponseDecoder("m");
    d.start();
    d.decode(frame({ deltaThinking: "hmm ", deltaSignature: "sig1" }));
    d.decode(frame({ deltaThinking: "more", deltaSignature: "sig2" }));
    d.decode(frame({ deltaText: "answer" }));
    const done = d.finish();
    const message = done.find((e) => e.type === "done")!.message!;
    expect(message.content[0]).toEqual({ type: "thinking", thinking: "hmm more", thinkingSignature: "sig1sig2", redacted: false });
    expect(message.content[1]).toEqual({ type: "text", text: "answer" });
  });

  it("fails on empty stream", () => {
    const d = new ResponseDecoder("m");
    d.start();
    const events = d.finish();
    expect(events[0]!.type).toBe("error");
    expect(events[0]!.error!.errorMessage).toContain("without generated content");
  });
});

describe("envelopes", () => {
  it("round-trips frames", async () => {
    const payloads = [new Uint8Array([1, 2, 3]), new Uint8Array([9])];
    const bytes = new Uint8Array([...encodeEnvelope(payloads[0]!), ...encodeEnvelope(payloads[1]!)]);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 4));
        c.enqueue(bytes.slice(4));
        c.close();
      },
    });
    const frames = [];
    for await (const f of decodeEnvelopes(stream)) frames.push(f);
    expect(frames.map((f) => Array.from(f.payload))).toEqual([[1, 2, 3], [9]]);
  });
});

describe("end-to-end stream", () => {
  const frameBytes = (init: Partial<GetChatMessageResponse>) =>
    encodeEnvelope(toBinary(GetChatMessageResponseSchema, create(GetChatMessageResponseSchema, init as Parameters<typeof create>[1])));

  it("streams events through a fake upstream", async () => {
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(frameBytes({ messageId: "msg-1", deltaText: "hi" }));
        c.enqueue(frameBytes({ deltaText: " there" }));
        c.enqueue(encodeEnvelope(new TextEncoder().encode("{}"), 0x02));
        c.close();
      },
    });
    const fetchImpl = async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://x/exa.api_server_pb.ApiServerService/GetChatMessage");
      expect((init!.headers as Record<string, string>)["content-type"]).toBe("application/connect+proto");
      expect((init!.headers as Record<string, string>).authorization).toBe("Basic tok-tok");
      return new Response(upstreamBody, { status: 200 });
    };
    const adapter = new DevinAdapter({ baseUrl: "http://x", token: "tok", model: "m" }, fetchImpl);
    const events: ResponseEvent[] = [];
    for await (const e of adapter.stream(req({ model: "m" }))) events.push(e);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("start");
    expect(types).toContain("text_delta");
    expect(types[types.length - 1]).toBe("done");
    const message = events.find((e) => e.type === "done")!.message!;
    expect(message.responseID).toBe("msg-1");
    expect(message.content[0]).toEqual({ type: "text", text: "hi there" });
  });

  it("surfaces connect end-frame errors", async () => {
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          encodeEnvelope(new TextEncoder().encode(JSON.stringify({ error: { code: "resource_exhausted", message: "quota" } })), 0x02),
        );
        c.close();
      },
    });
    const adapter = new DevinAdapter({ baseUrl: "http://x", token: "tok", model: "m" }, async () => new Response(upstreamBody));
    const events: ResponseEvent[] = [];
    for await (const e of adapter.stream(req({ model: "m" }))) events.push(e);
    const last = events[events.length - 1]!;
    expect(last.type).toBe("error");
    expect(last.error!.errorMessage).toBe("resource_exhausted: quota");
  });

  it("returns upstream error on non-200", async () => {
    const adapter = new DevinAdapter(
      { baseUrl: "http://x", token: "tok", model: "m" },
      async () => new Response(JSON.stringify({ code: "unauthenticated", message: "bad token" }), { status: 401 }),
    );
    const gen = adapter.stream(req({ model: "m" }));
    await expect(gen.next()).rejects.toThrow("unauthenticated: bad token");
  });
});

describe("tool helpers", () => {
  it("formats descriptions into numbered sentences", () => {
    expect(formatToolDescription("First thing. Second thing.")).toBe("1. First thing.\n2. Second thing.");
    expect(formatToolDescription("Keeps ```code\nblock\n``` intact.")).toContain("```code");
  });
  it("strips schema annotations except under properties", () => {
    // "properties" keys are property names (kept verbatim), but annotations inside
    // each property's schema are still stripped. Literal keys (const/default/enum/...)
    // keep their values untouched.
    const out = stripSchemaAnnotations(
      JSON.stringify({
        description: "d",
        title: "t",
        "x-a": 1,
        const: { description: "kept" },
        properties: {
          p: { description: "stripped", type: "string" },
          description: { type: "string", title: "stripped too" },
        },
      }),
    );
    expect(JSON.parse(out)).toEqual({
      const: { description: "kept" },
      properties: { p: { type: "string" }, description: { type: "string" } },
    });
  });
  it("withToolDescriptions skips empty descriptions", () => {
    expect(withToolDescriptions("sys", [{ name: "a", description: "" }])).toBe("sys");
    expect(withToolDescriptions("", [{ name: "a", description: "Use it." }])).toBe("# tools descriptions\n<tool name=\"a\">\n1. Use it.\n</tool>");
  });
  it("modelLikelySupportsImages", () => {
    expect(modelLikelySupportsImages("glm-4.7-foo")).toBe(false);
    expect(modelLikelySupportsImages("deepseek-v3")).toBe(false);
    expect(modelLikelySupportsImages("o3-mini-x")).toBe(false);
    expect(modelLikelySupportsImages("claude-opus")).toBe(true);
  });
  it("parseConnectErrorBody", () => {
    expect(parseConnectErrorBody('{"code":"not_found","message":"nope"}', 404)).toBe("not_found: nope");
    expect(parseConnectErrorBody("oops", 500)).toContain("HTTP 500");
  });
});
