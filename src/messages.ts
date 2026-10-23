// Anthropic Messages protocol — port of internal/api/anthropic/messages.

import { DecodeError, anthropicErrorType, decodeImagePart } from "./common.js";
import {
  emptyUsage,
  validateRequestMessages,
  type AssistantMessage,
  type Content,
  type ImageContent,
  type Message,
  type RequestMessages,
  type ResponseEvent,
  type StopReason,
  type Usage,
} from "./llm.js";

// ---- request decode ----

export type RequestOptions = {
  stream: boolean;
  maxOutputTokens: number;
  temperature?: number;
};

export type AdaptedRequest = { context: RequestMessages; options: RequestOptions };

export function decodeRequest(data: string): AdaptedRequest {
  let request: {
    model?: string;
    messages?: { role?: string; content?: unknown }[];
    system?: unknown;
    max_tokens?: number;
    tools?: { name?: string; description?: string; input_schema?: unknown }[];
    stream?: boolean;
    temperature?: number;
  };
  try {
    request = JSON.parse(data);
  } catch (e) {
    throw new DecodeError(`decode anthropic request: ${(e as Error).message}`);
  }
  if (typeof request !== "object" || request === null) {
    throw new DecodeError("decode anthropic request: body must be a JSON object");
  }
  if (!request.model) throw new DecodeError("anthropic request model is required");
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new DecodeError("anthropic request messages are required");
  }
  const context: RequestMessages = { model: request.model, systemPrompt: "", messages: [], tools: [] };
  if (request.system !== undefined && request.system !== null) {
    appendSystem(context, request.system);
  }
  request.messages.forEach((message, index) => {
    try {
      appendMessage(context, message ?? {});
    } catch (e) {
      throw new DecodeError(`message[${index}]: ${(e as Error).message}`);
    }
  });
  for (const tool of request.tools ?? []) {
    const schema =
      tool.input_schema === undefined || tool.input_schema === null
        ? '{"type":"object"}'
        : JSON.stringify(tool.input_schema);
    context.tools.push({ name: tool.name ?? "", description: tool.description ?? "", inputSchema: schema });
  }
  try {
    validateRequestMessages(context);
  } catch (e) {
    throw new DecodeError(`validate adapted request: ${(e as Error).message}`);
  }
  return {
    context,
    options: {
      stream: request.stream === true,
      maxOutputTokens: request.max_tokens ?? 0,
      temperature: request.temperature,
    },
  };
}

function appendSystem(context: RequestMessages, raw: unknown): void {
  if (typeof raw === "string") {
    context.systemPrompt = raw;
    return;
  }
  if (!Array.isArray(raw)) {
    throw new DecodeError("decode anthropic system: must be a string or block array");
  }
  for (const part of raw) {
    const block = part as { type?: string; text?: string };
    if (block === null || typeof block !== "object") throw new DecodeError("decode anthropic system: invalid block");
    if (block.type !== "text") continue;
    const text = typeof block.text === "string" ? block.text : "";
    if (context.systemPrompt !== "" && text !== "") context.systemPrompt += "\n";
    context.systemPrompt += text;
  }
}

function appendMessage(context: RequestMessages, message: { role?: string; content?: unknown }): void {
  if (message.role === "user") {
    const out = decodeAnthropicUserMessages(context.messages, message.content);
    context.messages.push(...out);
    return;
  }
  if (message.role === "assistant") {
    const content = decodeAssistantContent(message.content);
    context.messages.push({ role: "assistant", content, usage: emptyUsage(), timestampMS: Date.now() });
    return;
  }
  // Unknown roles are ignored.
}

function decodeAnthropicUserMessages(prior: Message[], raw: unknown): Message[] {
  const now = Date.now();
  // Tool results produced here become visible to later findToolNameByToolUseID
  // lookups within this same user message — track them on a copy so they are not
  // emitted twice into context.messages.
  const existing = [...prior];
  if (raw === undefined || raw === null) {
    return [{ role: "user", content: [{ type: "text", text: "" }], timestampMS: now }];
  }
  if (typeof raw === "string") {
    return [{ role: "user", content: [{ type: "text", text: raw }], timestampMS: now }];
  }
  if (!Array.isArray(raw)) {
    throw new DecodeError("decode user content: must be a string or part array");
  }
  const result: Message[] = [];
  let currentUserContent: Content[] = [];
  const flushUser = () => {
    if (currentUserContent.length === 0) return;
    result.push({ role: "user", content: currentUserContent, timestampMS: now });
    currentUserContent = [];
  };
  raw.forEach((part, index) => {
    const header = part as {
      type?: string;
      text?: string;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    };
    if (header === null || typeof header !== "object") {
      throw new DecodeError(`content[${index}]: invalid part`);
    }
    try {
      if (header.type === "text") {
        currentUserContent.push({ type: "text", text: typeof header.text === "string" ? header.text : "" });
      } else if (header.type === "image") {
        currentUserContent.push(decodeImagePart(part as Record<string, unknown>));
      } else if (header.type === "tool_result") {
        flushUser();
        const tool = decodeToolResult(existing, header.tool_use_id ?? "", header.content, header.is_error === true);
        result.push(tool);
        existing.push(tool);
      }
    } catch (e) {
      throw new DecodeError(`content[${index}]: ${(e as Error).message}`);
    }
  });
  flushUser();
  return result;
}

function decodeAssistantContent(raw: unknown): Content[] {
  if (raw === undefined || raw === null) {
    return [{ type: "text", text: "" }];
  }
  if (typeof raw === "string") {
    return [{ type: "text", text: raw }];
  }
  if (!Array.isArray(raw)) {
    throw new DecodeError("decode assistant content: must be a string or part array");
  }
  const content: Content[] = [];
  raw.forEach((part, index) => {
    const header = part as { type?: string; text?: string; id?: string; name?: string; input?: unknown };
    if (header === null || typeof header !== "object") {
      throw new DecodeError(`content[${index}]: invalid part`);
    }
    if (header.type === "text") {
      content.push({ type: "text", text: typeof header.text === "string" ? header.text : "" });
    } else if (header.type === "thinking") {
      content.push({ type: "thinking", thinking: typeof header.text === "string" ? header.text : "", thinkingSignature: "", redacted: false });
    } else if (header.type === "tool_use") {
      const input = header.input === undefined || header.input === null ? {} : header.input;
      content.push({ type: "toolCall", id: header.id ?? "", name: header.name ?? "", arguments: JSON.stringify(input) });
    }
  });
  return content;
}

function decodeToolResult(existing: Message[], toolUseID: string, raw: unknown, isError: boolean): Message {
  if (toolUseID === "") throw new DecodeError("tool_result requires tool_use_id");
  const name = findToolNameByToolUseID(existing, toolUseID);
  let content: Content[];
  try {
    content = decodeAnthropicContent(raw);
  } catch (e) {
    throw e instanceof DecodeError ? e : new DecodeError((e as Error).message);
  }
  if (content.length === 0) content = [{ type: "text", text: "" }];
  return { role: "toolResult", toolCallID: toolUseID, toolName: name, content, isError, timestampMS: Date.now() };
}

function decodeAnthropicContent(raw: unknown): Content[] {
  if (raw === undefined || raw === null) return [{ type: "text", text: "" }];
  if (typeof raw === "string") return [{ type: "text", text: raw }];
  if (!Array.isArray(raw)) throw new DecodeError("decode content: must be a string or part array");
  const content: Content[] = [];
  raw.forEach((part, index) => {
    const header = part as { type?: string; text?: string };
    if (header === null || typeof header !== "object") {
      throw new DecodeError(`content[${index}]: invalid part`);
    }
    try {
      if (header.type === "text") {
        content.push({ type: "text", text: typeof header.text === "string" ? header.text : "" });
      } else if (header.type === "image") {
        content.push(decodeImagePart(part as Record<string, unknown>));
      }
    } catch (e) {
      throw new DecodeError(`content[${index}]: ${(e as Error).message}`);
    }
  });
  return content;
}

function findToolNameByToolUseID(messages: Message[], toolUseID: string): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    for (const block of m.content) {
      if (block.type === "toolCall" && block.id === toolUseID) return block.name;
    }
  }
  return "tool";
}

// ---- response encode ----

export type SSEEvent = { name: string; data: string };

type Json = Record<string, unknown>;

function newMessageID(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `msg_${hex}`;
}

function parseJSONOrEmpty(input: string): unknown {
  try {
    const parsed: unknown = JSON.parse(input);
    return parsed ?? {};
  } catch {
    return {};
  }
}

function messageToAnthropic(message: AssistantMessage): Json[] {
  const blocks: Json[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "thinking") {
      const b: Json = { type: "thinking", thinking: block.thinking };
      if (block.thinkingSignature !== "") b.signature = block.thinkingSignature;
      blocks.push(b);
    } else if (block.type === "toolCall") {
      blocks.push({ type: "tool_use", id: block.id, name: block.name, input: parseJSONOrEmpty(block.arguments) });
    }
  }
  return blocks;
}

function anthropicUsage(usage: Usage): Json {
  return {
    input_tokens: usage.input,
    output_tokens: usage.output,
    cache_creation_input_tokens: usage.cacheWrite,
    cache_read_input_tokens: usage.cacheRead,
  };
}

function anthropicStopReason(reason: StopReason | undefined): string | null {
  switch (reason) {
    case "toolUse":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "stop":
      return "end_turn";
    case "error":
    case "aborted":
      return "error";
    default:
      return null;
  }
}

export function encodeResponse(message: AssistantMessage): Json {
  const model = message.responseModel || message.model || "claude";
  return {
    id: newMessageID(),
    type: "message",
    role: "assistant",
    content: messageToAnthropic(message),
    model,
    stop_reason: anthropicStopReason(message.stopReason),
    usage: anthropicUsage(message.usage),
  };
}

// ---- stream encoder ----

type ContentBlockState = {
  index: number;
  kind: string;
  text: string;
  thinking: string;
  signature: string;
  input: string;
  toolID: string;
  toolName: string;
};

export class StreamEncoder {
  private model: string;
  private messageID = newMessageID();
  private usage = emptyUsage();
  private blocks: ContentBlockState[] = [];
  private finished = false;

  constructor(model: string) {
    this.model = model;
  }

  encode(event: ResponseEvent): SSEEvent[] {
    switch (event.type) {
      case "start":
        return this.start(event);
      case "text_start":
        return this.startText(event);
      case "text_delta":
        return this.textDelta(event);
      case "text_end":
        return this.endText(event);
      case "thinking_start":
        return this.startThinking(event);
      case "thinking_delta":
        return this.thinkingDelta(event);
      case "thinking_end":
        return this.endThinking(event);
      case "toolcall_start":
        return this.startToolUse(event);
      case "toolcall_delta":
        return this.toolUseDelta(event);
      case "toolcall_end":
        return this.endToolUse(event);
      case "done":
        return this.finish(event);
      case "error":
        return this.failed(event);
      default:
        throw new Error(`unsupported response event type "${event.type}"`);
    }
  }

  private event(name: string, payload: Json): SSEEvent {
    return { name, data: JSON.stringify(payload) };
  }

  private block(index: number, kind: string): ContentBlockState | undefined {
    for (const state of this.blocks) {
      if (state.index === index && state.kind === kind) return state;
    }
    return undefined;
  }

  private start(event: ResponseEvent): SSEEvent[] {
    if (event.message) this.usage = event.message.usage;
    return [
      this.event("message_start", {
        type: "message_start",
        message: {
          id: this.messageID,
          type: "message",
          role: "assistant",
          content: [],
          model: this.model,
          stop_reason: null,
          usage: { input_tokens: this.usage.input, output_tokens: 0 },
        },
      }),
    ];
  }

  private startText(event: ResponseEvent): SSEEvent[] {
    this.blocks.push({ index: event.contentIndex!, kind: "text", text: "", thinking: "", signature: "", input: "", toolID: "", toolName: "" });
    return [
      this.event("content_block_start", {
        type: "content_block_start",
        index: event.contentIndex,
        content_block: { type: "text", text: "" },
      }),
    ];
  }

  private textDelta(event: ResponseEvent): SSEEvent[] {
    const state = this.block(event.contentIndex!, "text");
    if (!state) return [];
    state.text += event.delta!;
    return [
      this.event("content_block_delta", {
        type: "content_block_delta",
        index: event.contentIndex,
        delta: { type: "text_delta", text: event.delta },
      }),
    ];
  }

  private endText(event: ResponseEvent): SSEEvent[] {
    const state = this.block(event.contentIndex!, "text");
    if (!state) return [];
    const text = event.content !== undefined && event.content !== "" ? event.content : state.text;
    return [
      this.event("content_block_stop", {
        type: "content_block_stop",
        index: event.contentIndex,
        content_block: { type: "text", text },
      }),
    ];
  }

  private startThinking(event: ResponseEvent): SSEEvent[] {
    this.blocks.push({ index: event.contentIndex!, kind: "thinking", text: "", thinking: "", signature: "", input: "", toolID: "", toolName: "" });
    return [
      this.event("content_block_start", {
        type: "content_block_start",
        index: event.contentIndex,
        content_block: { type: "thinking", thinking: "", signature: "" },
      }),
    ];
  }

  private thinkingDelta(event: ResponseEvent): SSEEvent[] {
    const state = this.block(event.contentIndex!, "thinking");
    if (!state) return [];
    state.thinking += event.delta!;
    return [
      this.event("content_block_delta", {
        type: "content_block_delta",
        index: event.contentIndex,
        delta: { type: "thinking_delta", thinking: event.delta },
      }),
    ];
  }

  private endThinking(event: ResponseEvent): SSEEvent[] {
    const state = this.block(event.contentIndex!, "thinking");
    if (!state) return [];
    let thinking = event.content !== undefined && event.content !== "" ? event.content : state.thinking;
    const block = event.partial?.content[event.contentIndex!];
    if (block?.type === "thinking") state.signature += block.thinkingSignature;
    const out: Json = { type: "thinking", thinking };
    if (state.signature !== "") out.signature = state.signature;
    return [
      this.event("content_block_stop", {
        type: "content_block_stop",
        index: event.contentIndex,
        content_block: out,
      }),
    ];
  }

  private startToolUse(event: ResponseEvent): SSEEvent[] {
    this.blocks.push({
      index: event.contentIndex!,
      kind: "tool_use",
      text: "",
      thinking: "",
      signature: "",
      input: "",
      toolID: event.toolCallID!,
      toolName: event.toolName!,
    });
    return [
      this.event("content_block_start", {
        type: "content_block_start",
        index: event.contentIndex,
        content_block: { type: "tool_use", id: event.toolCallID, name: event.toolName, input: {} },
      }),
    ];
  }

  private toolUseDelta(event: ResponseEvent): SSEEvent[] {
    const state = this.block(event.contentIndex!, "tool_use");
    if (!state) return [];
    state.input += event.delta!;
    return [
      this.event("content_block_delta", {
        type: "content_block_delta",
        index: event.contentIndex,
        delta: { type: "input_json_delta", partial_json: event.delta },
      }),
    ];
  }

  private endToolUse(event: ResponseEvent): SSEEvent[] {
    const state = this.block(event.contentIndex!, "tool_use");
    if (!state) return [];
    let input = state.input;
    if (event.toolCall) {
      input = event.toolCall.arguments;
      state.toolID = event.toolCall.id;
      state.toolName = event.toolCall.name;
    }
    return [
      this.event("content_block_stop", {
        type: "content_block_stop",
        index: event.contentIndex,
        content_block: { type: "tool_use", id: state.toolID, name: state.toolName, input: parseJSONOrEmpty(input) },
      }),
    ];
  }

  private finish(event: ResponseEvent): SSEEvent[] {
    this.finished = true;
    if (event.message) this.usage = event.message.usage;
    const delta: Json = { stop_reason: anthropicStopReason(event.reason), stop_sequence: null };
    return [
      this.event("message_delta", {
        type: "message_delta",
        delta,
        usage: { output_tokens: this.usage.output },
      }),
      this.event("message_stop", { type: "message_stop" }),
    ];
  }

  private failed(event: ResponseEvent): SSEEvent[] {
    this.finished = true;
    let message = "anthropic message stream failed";
    if (event.error?.errorMessage) message = event.error.errorMessage;
    return [
      this.event("error", {
        type: "error",
        error: { type: anthropicErrorType(message), message },
      }),
    ];
  }
}
