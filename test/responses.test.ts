import { describe, it, expect } from "vitest";
import { decodeRequest, encodeResponse, StreamEncoder } from "../src/responses.js";
import { emptyUsage, type AssistantMessage } from "../src/llm.js";

const doneMessage = (over: Partial<AssistantMessage> = {}): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: "hi" }],
  api: "connect",
  provider: "devin",
  model: "m",
  responseModel: "m2",
  responseID: "resp_abc",
  usage: { ...emptyUsage(), input: 10, output: 5, totalTokens: 15 },
  stopReason: "stop",
  timestampMS: 1700000000000,
  ...over,
});

describe("decodeRequest", () => {
  it("accepts string input", () => {
    const { context, options } = decodeRequest(JSON.stringify({ model: "m", input: "hello", stream: true }));
    expect(context.model).toBe("m");
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0]).toMatchObject({ role: "user" });
    expect(options.stream).toBe(true);
  });
  it("decodes message/function_call/function_call_output items", () => {
    const { context } = decodeRequest(
      JSON.stringify({
        model: "m",
        instructions: "sys",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "q" }] },
          { type: "function_call", call_id: "c1", name: "tool", arguments: '{"x":1}' },
          { type: "function_call_output", call_id: "c1", output: "done" },
        ],
      }),
    );
    expect(context.systemPrompt).toBe("sys");
    expect(context.messages[1]).toMatchObject({ role: "assistant", stopReason: "toolUse" });
    expect(context.messages[2]).toMatchObject({ role: "toolResult", toolCallID: "c1", toolName: "tool" });
  });
  it("errors on unknown call_id and missing model", () => {
    expect(() => decodeRequest(JSON.stringify({ input: "x" }))).toThrow(/model is required/);
    expect(() =>
      decodeRequest(JSON.stringify({ model: "m", input: [{ type: "function_call_output", call_id: "nope", output: "x" }] })),
    ).toThrow(/unknown call_id/);
  });
  it("maps function tools and merges developer message into system prompt", () => {
    const { context } = decodeRequest(
      JSON.stringify({
        model: "m",
        input: [{ type: "message", role: "developer", content: [{ type: "text", text: "be terse" }] }],
        tools: [{ type: "function", name: "t", description: "d", parameters: { type: "object" } }, { type: "web_search" }],
      }),
    );
    expect(context.systemPrompt).toBe("be terse");
    expect(context.tools).toHaveLength(1);
    expect(context.tools[0]!.name).toBe("t");
  });
});

describe("encodeResponse", () => {
  it("emits a completed response object", () => {
    const r = encodeResponse(doneMessage()) as Record<string, unknown>;
    expect(r.object).toBe("response");
    expect(r.status).toBe("completed");
    expect(r.id).toBe("resp_abc");
    expect(r.model).toBe("m2");
    expect(r.store).toBe(true);
    const output = r.output as { type: string }[];
    expect(output[0]!.type).toBe("message");
    const usage = r.usage as Record<string, number>;
    expect(usage.input_tokens).toBe(10);
    expect(usage.output_tokens).toBe(5);
    expect(usage.total_tokens).toBe(15);
  });
  it("orders reasoning before message and marks incomplete", () => {
    const r = encodeResponse(
      doneMessage({
        stopReason: "length",
        content: [
          { type: "text", text: "answer" },
          { type: "thinking", thinking: "hmm", thinkingSignature: "sig", redacted: false },
          { type: "toolCall", id: "c", name: "t", arguments: "{}" },
        ],
      }),
    ) as Record<string, unknown>;
    expect(r.status).toBe("incomplete");
    const types = (r.output as { type: string }[]).map((o) => o.type);
    expect(types).toEqual(["reasoning", "function_call", "message"]);
    expect((r.output as { encrypted_content?: string }[])[0]!.encrypted_content).toBe("sig");
  });
});

describe("StreamEncoder", () => {
  const partial = (): AssistantMessage => ({
    role: "assistant",
    content: [{ type: "text", text: "" }],
    usage: emptyUsage(),
    timestampMS: 0,
  });

  it("emits full lifecycle for text", () => {
    const enc = new StreamEncoder("m");
    const out = [
      ...enc.encode({ type: "start", partial: partial() }),
      ...enc.encode({ type: "text_start", contentIndex: 0, partial: partial() }),
      ...enc.encode({ type: "text_delta", contentIndex: 0, delta: "he", partial: partial() }),
      ...enc.encode({ type: "text_end", contentIndex: 0, content: "he", partial: partial() }),
      ...enc.encode({ type: "done", reason: "stop", message: doneMessage() }),
    ];
    const names = out.map((e) => e.name);
    expect(names[0]).toBe("response.created");
    expect(names[1]).toBe("response.in_progress");
    expect(names).toContain("response.output_item.added");
    expect(names).toContain("response.output_text.delta");
    expect(names).toContain("response.output_item.done");
    expect(names[names.length - 1]).toBe("response.completed");
    const seqs = out.map((e) => (JSON.parse(e.data) as { sequence_number: number }).sequence_number);
    expect(seqs).toEqual([...Array(seqs.length).keys()]);
  });

  it("emits reasoning + function_call + response.incomplete", () => {
    const enc = new StreamEncoder("m");
    const partialMsg: AssistantMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "t", thinkingSignature: "s", redacted: false },
        { type: "toolCall", id: "c", name: "n", arguments: "{}" },
      ],
      usage: emptyUsage(),
      timestampMS: 0,
    };
    const events = [
      ...enc.encode({ type: "start", partial: partialMsg }),
      ...enc.encode({ type: "thinking_start", contentIndex: 0, partial: partialMsg }),
      ...enc.encode({ type: "thinking_delta", contentIndex: 0, delta: "t", partial: partialMsg }),
      ...enc.encode({ type: "thinking_end", contentIndex: 0, content: "t", partial: partialMsg }),
      ...enc.encode({ type: "toolcall_start", contentIndex: 1, toolCallID: "c", toolName: "n", partial: partialMsg }),
      ...enc.encode({ type: "toolcall_delta", contentIndex: 1, toolCallID: "c", delta: "{}", partial: partialMsg }),
      ...enc.encode({ type: "toolcall_end", contentIndex: 1, toolCall: { type: "toolCall", id: "c", name: "n", arguments: "{}" }, partial: partialMsg }),
      ...enc.encode({ type: "done", reason: "length", message: doneMessage({ stopReason: "length" }) }),
    ];
    const names = events.map((e) => e.name);
    expect(names).toContain("response.reasoning_summary_text.delta");
    expect(names).toContain("response.function_call_arguments.done");
    expect(names[names.length - 1]).toBe("response.incomplete");
    const final = JSON.parse(events[events.length - 1]!.data) as { response: { incomplete_details: { reason: string } } };
    expect(final.response.incomplete_details.reason).toBe("max_output_tokens");
  });

  it("emits response.failed on error", () => {
    const enc = new StreamEncoder("m");
    enc.encode({ type: "start", partial: partial() });
    const events = enc.encode({
      type: "error",
      reason: "error",
      error: { ...partial(), errorMessage: "unauthenticated: bad key" },
    });
    expect(events[0]!.name).toBe("response.failed");
    const data = JSON.parse(events[0]!.data) as { error: { type: string } };
    expect(data.error.type).toBe("authentication_error");
  });
});
