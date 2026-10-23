import { describe, it, expect } from "vitest";
import * as chat from "../src/chat.js";
import * as messages from "../src/messages.js";
import { emptyUsage, type AssistantMessage } from "../src/llm.js";

const doneMessage = (over: Partial<AssistantMessage> = {}): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: "hi" }],
  model: "m",
  responseModel: "m2",
  usage: { ...emptyUsage(), input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18 },
  stopReason: "stop",
  timestampMS: 1700000000000,
  ...over,
});

describe("chat.decodeRequest", () => {
  it("decodes roles incl system merge, assistant tool_calls, tool results", () => {
    const { context, options } = chat.decodeRequest(
      JSON.stringify({
        model: "m",
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: "system", content: "sys1" },
          { role: "developer", content: [{ type: "text", text: "sys2" }] },
          { role: "user", content: "q" },
          { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: '{"a":1}' } }] },
          { role: "tool", tool_call_id: "c1", content: "res" },
        ],
      }),
    );
    expect(context.systemPrompt).toBe("sys1\nsys2");
    expect(context.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult"]);
    expect(context.messages[2]).toMatchObject({ toolCallID: "c1", toolName: "t" });
    expect(options.includeUsage).toBe(true);
  });
  it("requires model + messages; errors on unknown tool_call_id; max_completion_tokens wins", () => {
    expect(() => chat.decodeRequest(JSON.stringify({ messages: [{}] }))).toThrow(/model is required/);
    expect(() => chat.decodeRequest(JSON.stringify({ model: "m", messages: [] }))).toThrow(/messages are required/);
    expect(() =>
      chat.decodeRequest(JSON.stringify({ model: "m", messages: [{ role: "tool", tool_call_id: "x", content: "r" }] })),
    ).toThrow(/unknown tool_call_id/);
    const { options } = chat.decodeRequest(
      JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }], max_tokens: 10, max_completion_tokens: 20 }),
    );
    expect(options.maxOutputTokens).toBe(20);
  });
});

describe("chat.encodeResponse", () => {
  it("emits chat.completion with finish_reason + usage", () => {
    const r = chat.encodeResponse(doneMessage()) as Record<string, unknown>;
    expect(r.object).toBe("chat.completion");
    expect((r.choices as { message: { content: string }; finish_reason: string }[])[0]!.message.content).toBe("hi");
    expect((r.choices as { finish_reason: string }[])[0]!.finish_reason).toBe("stop");
    const usage = r.usage as Record<string, number>;
    expect(usage.prompt_tokens).toBe(13); // input + cacheRead + cacheWrite
    expect(usage.completion_tokens).toBe(5);
  });
  it("nulls content when tool_calls present", () => {
    const r = chat.encodeResponse(
      doneMessage({ stopReason: "toolUse", content: [{ type: "toolCall", id: "c", name: "t", arguments: "{}" }] }),
    ) as Record<string, unknown>;
    const msg = (r.choices as { message: Record<string, unknown> }[])[0]!.message;
    expect(msg.content).toBeNull();
    expect(msg.tool_calls).toHaveLength(1);
  });
});

describe("chat.StreamEncoder", () => {
  it("emits role, deltas, finish, [DONE]; include_usage adds usage chunk", () => {
    const enc = new chat.StreamEncoder("m", true);
    const out = [
      ...enc.encode({ type: "start", partial: doneMessage() }),
      ...enc.encode({ type: "text_start", contentIndex: 0, partial: doneMessage() }),
      ...enc.encode({ type: "text_delta", contentIndex: 0, delta: "he", partial: doneMessage() }),
      ...enc.encode({ type: "text_end", contentIndex: 0, partial: doneMessage() }),
      ...enc.encode({ type: "done", reason: "stop", message: doneMessage() }),
    ];
    const chunks = out.filter((e) => e.name !== "[DONE]");
    expect((JSON.parse(chunks[0]!.data) as { choices: { delta: { role: string } }[] }).choices[0]!.delta.role).toBe("assistant");
    expect(
      (JSON.parse(chunks[1]!.data) as { choices: { delta: { content: string } }[] }).choices[0]!.delta.content,
    ).toBe("he");
    expect(
      (JSON.parse(chunks[2]!.data) as { choices: { finish_reason: string }[] }).choices[0]!.finish_reason,
    ).toBe("stop");
    expect((JSON.parse(chunks[3]!.data) as { usage: { total_tokens: number } }).usage.total_tokens).toBe(18);
    expect(out[out.length - 1]!.data).toBe("[DONE]");
  });
  it("streams reasoning_content and indexed tool_calls", () => {
    const enc = new chat.StreamEncoder("m", false);
    const out = [
      ...enc.encode({ type: "thinking_start", contentIndex: 0, partial: doneMessage() }),
      ...enc.encode({ type: "thinking_delta", contentIndex: 0, delta: "th", partial: doneMessage() }),
      ...enc.encode({ type: "thinking_end", contentIndex: 0, partial: doneMessage() }),
      ...enc.encode({ type: "toolcall_start", contentIndex: 1, toolCallID: "c", toolName: "t", partial: doneMessage() }),
      ...enc.encode({ type: "toolcall_delta", contentIndex: 1, toolCallID: "c", delta: "{}", partial: doneMessage() }),
    ];
    const deltas = out.map((e) => (JSON.parse(e.data) as { choices: { delta: Record<string, unknown> }[] }).choices[0]!.delta);
    expect(deltas[0]).toEqual({ reasoning_content: "th" });
    expect(deltas[1]).toEqual({ tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "t", arguments: "" } }] });
    expect(deltas[2]).toEqual({ tool_calls: [{ index: 0, function: { arguments: "{}" } }] });
  });
});

describe("messages.decodeRequest", () => {
  it("decodes system (string + blocks), user text/image/tool_result, assistant blocks", () => {
    const { context, options } = messages.decodeRequest(
      JSON.stringify({
        model: "m",
        max_tokens: 100,
        system: [{ type: "text", text: "a" }, { type: "text", text: "b" }],
        messages: [
          { role: "user", content: [{ type: "text", text: "q" }] },
          {
            role: "assistant",
            content: [
              { type: "thinking", text: "hmm" },
              { type: "text", text: "ok" },
              { type: "tool_use", id: "u1", name: "run", input: { x: 1 } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "u1", content: [{ type: "text", text: "done" }], is_error: false },
              { type: "text", text: "more" },
            ],
          },
        ],
      }),
    );
    expect(context.systemPrompt).toBe("a\nb");
    expect(context.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "user"]);
    expect(context.messages[2]).toMatchObject({ toolCallID: "u1", toolName: "run", isError: false });
    expect((context.messages[1] as AssistantMessage).content[2]).toMatchObject({ type: "toolCall", id: "u1", arguments: '{"x":1}' });
    expect(options.maxOutputTokens).toBe(100);
  });
  it("errors on missing tool_use_id; default tool name is 'tool'", () => {
    expect(() =>
      messages.decodeRequest(
        JSON.stringify({ model: "m", max_tokens: 1, messages: [{ role: "user", content: [{ type: "tool_result", content: "x" }] }] }),
      ),
    ).toThrow(/tool_use_id/);
    const { context } = messages.decodeRequest(
      JSON.stringify({
        model: "m",
        max_tokens: 1,
        messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "unknown", content: "x" }] }],
      }),
    );
    expect(context.messages[0]).toMatchObject({ toolName: "tool" });
  });
});

describe("messages.encodeResponse", () => {
  it("emits message with content blocks + anthropic usage", () => {
    const r = messages.encodeResponse(
      doneMessage({
        stopReason: "toolUse",
        content: [
          { type: "thinking", thinking: "h", thinkingSignature: "sig", redacted: false },
          { type: "toolCall", id: "u", name: "t", arguments: '{"a":2}' },
        ],
      }),
    ) as Record<string, unknown>;
    expect(r.type).toBe("message");
    expect((r.id as string).startsWith("msg_")).toBe(true);
    const content = r.content as Record<string, unknown>[];
    expect(content[0]).toEqual({ type: "thinking", thinking: "h", signature: "sig" });
    expect(content[1]).toEqual({ type: "tool_use", id: "u", name: "t", input: { a: 2 } });
    expect(r.stop_reason).toBe("tool_use");
    const usage = r.usage as Record<string, number>;
    expect(usage.cache_read_input_tokens).toBe(2);
    expect(usage.cache_creation_input_tokens).toBe(1);
  });
});

describe("messages.StreamEncoder", () => {
  it("emits message_start → content blocks → message_delta → message_stop", () => {
    const enc = new messages.StreamEncoder("m");
    const p = doneMessage();
    const out = [
      ...enc.encode({ type: "start", partial: p }),
      ...enc.encode({ type: "thinking_start", contentIndex: 0, partial: p }),
      ...enc.encode({ type: "thinking_delta", contentIndex: 0, delta: "th", partial: p }),
      ...enc.encode({ type: "thinking_end", contentIndex: 0, content: "th", partial: p }),
      ...enc.encode({ type: "text_start", contentIndex: 1, partial: p }),
      ...enc.encode({ type: "text_delta", contentIndex: 1, delta: "hi", partial: p }),
      ...enc.encode({ type: "text_end", contentIndex: 1, content: "hi", partial: p }),
      ...enc.encode({ type: "toolcall_start", contentIndex: 2, toolCallID: "u", toolName: "t", partial: p }),
      ...enc.encode({ type: "toolcall_delta", contentIndex: 2, toolCallID: "u", delta: '{"a"', partial: p }),
      ...enc.encode({ type: "toolcall_end", contentIndex: 2, toolCall: { type: "toolCall", id: "u", name: "t", arguments: '{"a":1}' }, partial: p }),
      ...enc.encode({ type: "done", reason: "stop", message: p }),
    ];
    const names = out.map((e) => e.name);
    expect(names).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const toolStop = JSON.parse(out[9]!.data) as { content_block: { type: string; input: { a: number } } };
    expect(toolStop.content_block).toEqual({ type: "tool_use", id: "u", name: "t", input: { a: 1 } });
    const md = JSON.parse(out[10]!.data) as { delta: { stop_reason: string }; usage: { output_tokens: number } };
    expect(md.delta.stop_reason).toBe("end_turn");
    expect(md.usage.output_tokens).toBe(5);
  });

  it("emits typed error event", () => {
    const enc = new messages.StreamEncoder("m");
    const out = enc.encode({ type: "error", reason: "error", error: doneMessage({ errorMessage: "unavailable: down" }) });
    expect(out[0]!.name).toBe("error");
    expect(JSON.parse(out[0]!.data)).toEqual({ type: "error", error: { type: "api_error", message: "unavailable: down" } });
  });
});
