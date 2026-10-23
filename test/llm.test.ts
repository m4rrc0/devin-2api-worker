import { describe, it, expect } from "vitest";
import { validateRequestMessages, validateEvent, emptyUsage, type AssistantMessage } from "../src/llm.js";

describe("validateRequestMessages", () => {
  it("accepts a minimal valid request", () => {
    validateRequestMessages({
      model: "m",
      systemPrompt: "",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestampMS: 1 }],
      tools: [],
    });
  });
  it("rejects tool call in user content", () => {
    expect(() =>
      validateRequestMessages({
        model: "m",
        systemPrompt: "",
        messages: [{ role: "user", content: [{ type: "toolCall", id: "a", name: "t", arguments: "{}" }], timestampMS: 0 }],
        tools: [],
      }),
    ).toThrow(/disallowed type/);
  });
  it("rejects image in assistant content", () => {
    expect(() =>
      validateRequestMessages({
        model: "m",
        systemPrompt: "",
        messages: [
          {
            role: "assistant",
            content: [{ type: "image", data: "x", mimeType: "image/png" }],
            usage: emptyUsage(),
            timestampMS: 0,
          },
        ],
        tools: [],
      }),
    ).toThrow(/disallowed type/);
  });
  it("rejects redacted thinking without signature", () => {
    expect(() =>
      validateRequestMessages({
        model: "m",
        systemPrompt: "",
        messages: [
          {
            role: "assistant",
            content: [{ type: "thinking", thinking: "", thinkingSignature: "", redacted: true }],
            usage: emptyUsage(),
            timestampMS: 0,
          },
        ],
        tools: [],
      }),
    ).toThrow(/signature/);
  });
  it("rejects bad tool schema and missing tool result fields", () => {
    expect(() =>
      validateRequestMessages({
        model: "m",
        systemPrompt: "",
        messages: [],
        tools: [{ name: "t", description: "", inputSchema: "[1]" }],
      }),
    ).toThrow(/input schema/);
    expect(() =>
      validateRequestMessages({
        model: "m",
        systemPrompt: "",
        messages: [{ role: "toolResult", toolCallID: "", toolName: "t", content: [], isError: false, timestampMS: 0 }],
        tools: [],
      }),
    ).toThrow(/call ID/);
  });
});

describe("validateEvent", () => {
  const partial: AssistantMessage = {
    role: "assistant",
    content: [],
    usage: emptyUsage(),
    timestampMS: 0,
  };
  it("accepts well-formed events", () => {
    validateEvent({ type: "start", partial });
    validateEvent({ type: "text_delta", contentIndex: 0, delta: "x", partial });
    validateEvent({ type: "done", reason: "stop", message: partial });
    validateEvent({ type: "error", reason: "error", error: partial });
  });
  it("rejects malformed events", () => {
    expect(() => validateEvent({ type: "start" })).toThrow(/partial/);
    expect(() => validateEvent({ type: "text_delta", contentIndex: 0, partial })).toThrow(/delta/);
    expect(() => validateEvent({ type: "done", reason: "pending", message: partial })).toThrow(/invalid done reason/);
    expect(() => validateEvent({ type: "toolcall_start", contentIndex: 0, partial })).toThrow(/tool call ID/);
  });
});
