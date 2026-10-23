// OpenAI Responses protocol — port of internal/api/openai/responses.

import { DecodeError, contentText, decodeContent, openAIErrorType, rawOutputText } from "./common.js";
import {
  validateRequestMessages,
  type AssistantMessage,
  type Content,
  type RequestMessages,
  type ResponseEvent,
  type StopReason,
  type Usage,
} from "./llm.js";

// ---- request decode ----

export type RequestOptions = {
  stream: boolean;
  maxOutputTokens?: number;
  temperature?: number;
  previousResponseID: string;
};

export type AdaptedRequest = { context: RequestMessages; options: RequestOptions };

export function decodeRequest(data: string): AdaptedRequest {
  let request: {
    model?: string;
    instructions?: string;
    input?: unknown;
    tools?: { type?: string; name?: string; description?: string; parameters?: unknown }[];
    stream?: boolean;
    max_output_tokens?: number;
    temperature?: number;
    previous_response_id?: string;
  };
  try {
    request = JSON.parse(data);
  } catch (e) {
    throw new DecodeError(`decode responses request: ${(e as Error).message}`);
  }
  if (typeof request !== "object" || request === null) {
    throw new DecodeError("decode responses request: body must be a JSON object");
  }
  if (!request.model) throw new DecodeError("responses request model is required");
  const context: RequestMessages = {
    model: request.model,
    systemPrompt: typeof request.instructions === "string" ? request.instructions : "",
    messages: [],
    tools: [],
  };
  appendInputMessages(context, request.input);
  for (const tool of request.tools ?? []) {
    if (tool.type !== "function") continue;
    const schema =
      tool.parameters === undefined || tool.parameters === null ? '{"type":"object"}' : JSON.stringify(tool.parameters);
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
      maxOutputTokens: request.max_output_tokens,
      temperature: request.temperature,
      previousResponseID: request.previous_response_id ?? "",
    },
  };
}

function appendInputMessages(context: RequestMessages, raw: unknown): void {
  if (raw === undefined || raw === null) return;
  if (typeof raw === "string") {
    context.messages.push({ role: "user", content: [{ type: "text", text: raw }], timestampMS: Date.now() });
    return;
  }
  if (!Array.isArray(raw)) {
    throw new DecodeError("decode responses input: must be a string or item array");
  }
  raw.forEach((item, index) => {
    try {
      appendInputItem(context, item);
    } catch (e) {
      throw new DecodeError(`input[${index}]: ${(e as Error).message}`);
    }
  });
}

function findToolName(messages: RequestMessages["messages"], callID: string): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    for (const block of m.content) {
      if (block.type === "toolCall" && block.id === callID) return block.name;
    }
  }
  return "";
}

function appendInputItem(context: RequestMessages, raw: unknown): void {
  const header = raw as { type?: string; role?: string };
  if (header === null || typeof header !== "object") {
    throw new DecodeError("decode input item: must be an object");
  }
  let type = header.type ?? "";
  if (type === "" && typeof header.role === "string" && header.role !== "") type = "message";
  if (type === "message") {
    appendMessageItem(context, raw, header.role ?? "");
    return;
  }
  if (type === "function_call") {
    const item = raw as { call_id?: string; name?: string; arguments?: string };
    context.messages.push({
      role: "assistant",
      content: [{ type: "toolCall", id: item.call_id ?? "", name: item.name ?? "", arguments: item.arguments ?? "{}" }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestampMS: Date.now(),
    });
    return;
  }
  if (type === "function_call_output") {
    const item = raw as { call_id?: string; output?: unknown };
    const callID = item.call_id ?? "";
    const output = rawOutputText(item.output);
    const toolName = findToolName(context.messages, callID);
    if (toolName === "") {
      throw new DecodeError(`function call output references unknown call_id "${callID}"`);
    }
    context.messages.push({
      role: "toolResult",
      toolCallID: callID,
      toolName,
      content: [{ type: "text", text: output }],
      isError: false,
      timestampMS: Date.now(),
    });
    return;
  }
  // Unknown item types are ignored.
}

function appendMessageItem(context: RequestMessages, raw: unknown, role: string): void {
  if (role !== "user" && role !== "assistant" && role !== "system" && role !== "developer") return;
  const item = raw as { content?: unknown };
  const content = decodeContent(item.content);
  if (content.length === 0) return;
  if (role === "user") {
    context.messages.push({ role: "user", content, timestampMS: Date.now() });
  } else if (role === "assistant") {
    context.messages.push({
      role: "assistant",
      content,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      timestampMS: Date.now(),
    });
  } else {
    const text = contentText(content);
    if (context.systemPrompt !== "" && text !== "") context.systemPrompt += "\n";
    context.systemPrompt += text;
  }
}

// ---- response encode ----

export type SSEEvent = { name: string; data: string };

function newResponseID(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `${prefix}_${hex}`;
}

type Json = Record<string, unknown>;

function responseStatus(reason: StopReason | undefined): string {
  if (reason === "length") return "incomplete";
  if (reason === "error" || reason === "aborted") return "failed";
  return "completed";
}

function baseResponse(id: string, model: string, createdAt: number, status: string): Json {
  return {
    id,
    object: "response",
    created_at: createdAt,
    status,
    error: null,
    incomplete_details: null,
    instructions: null,
    model,
    output: [],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: true,
    temperature: null,
    top_p: null,
    truncation: "disabled",
    tool_choice: "auto",
    tools: [],
    usage: null,
    metadata: {},
    max_output_tokens: null,
    text: { format: { type: "text" } },
  };
}

function responseUsage(usage: Usage): Json {
  const reasoningTokens = usage.reasoning ?? 0;
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  const total = usage.totalTokens !== 0 ? usage.totalTokens : inputTokens + usage.output;
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: usage.cacheRead, cache_write_tokens: usage.cacheWrite },
    output_tokens: usage.output,
    output_tokens_details: { reasoning_tokens: reasoningTokens },
    total_tokens: total,
  };
}

function outputFromMessage(message: AssistantMessage): Json[] {
  const reasonings: Json[] = [];
  const toolCalls: Json[] = [];
  const messages: Json[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      messages.push({
        id: newResponseID("msg"),
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: block.text, annotations: [] }],
      });
    } else if (block.type === "thinking") {
      const item: Json = {
        id: newResponseID("rs"),
        type: "reasoning",
        status: "completed",
        summary: [{ type: "summary_text", text: block.thinking }],
      };
      if (block.thinkingSignature !== "") item.encrypted_content = block.thinkingSignature;
      reasonings.push(item);
    } else if (block.type === "toolCall") {
      toolCalls.push({
        id: newResponseID("fc"),
        type: "function_call",
        status: "completed",
        call_id: block.id,
        name: block.name,
        arguments: block.arguments,
      });
    } else {
      throw new Error(`unsupported response content type "${(block as Content).type}"`);
    }
  }
  return [...reasonings, ...toolCalls, ...messages];
}

export function encodeResponse(message: AssistantMessage): Json {
  const output = outputFromMessage(message);
  const model = message.responseModel || message.model || "";
  let responseID = message.responseID ?? "";
  if (!responseID.startsWith("resp_")) responseID = newResponseID("resp");
  const createdAt = message.timestampMS > 0 ? Math.floor(message.timestampMS / 1000) : Math.floor(Date.now() / 1000);
  const status = responseStatus(message.stopReason);
  const response = baseResponse(responseID, model, createdAt, status);
  if (status === "completed") response.completed_at = Math.floor(Date.now() / 1000);
  response.output = output;
  response.usage = responseUsage(message.usage);
  return response;
}

// ---- stream encoder ----

type StreamItem = {
  kind: string;
  id: string;
  outputIndex: number;
  callID: string;
  name: string;
  contentIndex: number;
  value: string;
  encryptedContent: string;
  closed: boolean;
};

export class StreamEncoder {
  private model: string;
  private responseID = newResponseID("resp");
  private createdAt = Math.floor(Date.now() / 1000);
  private sequenceNumber = 0;
  private items = new Map<number, StreamItem>();
  private output: (Json | undefined)[] = [];
  private started = false;
  private completed = false;

  constructor(model: string) {
    this.model = model;
  }

  encode(event: ResponseEvent): SSEEvent[] {
    if (this.completed) throw new Error("response stream is already completed");
    switch (event.type) {
      case "start":
        return this.start();
      case "thinking_start":
        return this.startReasoning(event);
      case "thinking_delta":
        return this.reasoningDelta(event);
      case "thinking_end":
        return this.endReasoning(event);
      case "text_start":
        return this.startText(event);
      case "text_delta":
        return this.textDelta(event);
      case "text_end":
        return this.endText(event);
      case "toolcall_start":
        return this.startToolCall(event);
      case "toolcall_delta":
        return this.toolCallDelta(event);
      case "toolcall_end":
        return this.endToolCall(event);
      case "done":
        return this.done(event);
      case "error":
        return this.failed(event);
      default:
        throw new Error(`unsupported response event type "${event.type}"`);
    }
  }

  private emit(name: string, payload: Json): SSEEvent {
    payload.type = name;
    payload.sequence_number = this.sequenceNumber++;
    return { name, data: JSON.stringify(payload) };
  }

  private start(): SSEEvent[] {
    if (this.started) return [];
    this.started = true;
    const created = baseResponse(this.responseID, this.model, this.createdAt, "in_progress");
    return [
      this.emit("response.created", { response: created }),
      this.emit("response.in_progress", { response: created }),
    ];
  }

  private newItem(contentIndex: number, kind: string, prefix: string): StreamItem {
    if (this.items.has(contentIndex)) {
      throw new Error(`content index ${contentIndex} already has an output item`);
    }
    const item: StreamItem = {
      kind,
      id: newResponseID(prefix),
      outputIndex: this.output.length,
      callID: "",
      name: "",
      contentIndex: 0,
      value: "",
      encryptedContent: "",
      closed: false,
    };
    this.items.set(contentIndex, item);
    this.output.push(undefined);
    return item;
  }

  private item(contentIndex: number, kind: string): StreamItem {
    const item = this.items.get(contentIndex);
    if (!item) throw new Error(`content index ${contentIndex} has no active output item`);
    if (item.kind !== kind) throw new Error(`content index ${contentIndex} is "${item.kind}", want "${kind}"`);
    if (item.closed) throw new Error(`content index ${contentIndex} output item is already closed`);
    return item;
  }

  private closeItem(item: StreamItem, output: Json): void {
    item.closed = true;
    this.output[item.outputIndex] = output;
  }

  private completedOutput(): Json[] {
    return this.output.filter((o): o is Json => o !== undefined);
  }

  private startReasoning(event: ResponseEvent): SSEEvent[] {
    const item = this.newItem(event.contentIndex!, "reasoning", "rs");
    const thinking = event.partial?.content[event.contentIndex!];
    if (thinking?.type === "thinking") item.encryptedContent = thinking.thinkingSignature;
    const addedItem: Json = { id: item.id, type: "reasoning", summary: [] };
    if (item.encryptedContent !== "") addedItem.encrypted_content = item.encryptedContent;
    return [
      this.emit("response.output_item.added", { output_index: item.outputIndex, item: addedItem }),
      this.emit("response.reasoning_summary_part.added", {
        item_id: item.id,
        output_index: item.outputIndex,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      }),
    ];
  }

  private reasoningDelta(event: ResponseEvent): SSEEvent[] {
    const item = this.item(event.contentIndex!, "reasoning");
    item.value += event.delta!;
    return [
      this.emit("response.reasoning_summary_text.delta", {
        item_id: item.id,
        output_index: item.outputIndex,
        summary_index: 0,
        delta: event.delta,
      }),
    ];
  }

  private endReasoning(event: ResponseEvent): SSEEvent[] {
    const item = this.item(event.contentIndex!, "reasoning");
    const text = event.content !== undefined && event.content !== "" ? event.content : item.value;
    const thinking = event.partial?.content[event.contentIndex!];
    if (thinking?.type === "thinking" && thinking.thinkingSignature !== "") {
      item.encryptedContent = thinking.thinkingSignature;
    }
    const completedItem: Json = {
      id: item.id,
      type: "reasoning",
      summary: [{ type: "summary_text", text }],
    };
    if (item.encryptedContent !== "") completedItem.encrypted_content = item.encryptedContent;
    this.closeItem(item, completedItem);
    return [
      this.emit("response.reasoning_summary_text.done", {
        item_id: item.id,
        output_index: item.outputIndex,
        summary_index: 0,
        text,
      }),
      this.emit("response.reasoning_summary_part.done", {
        item_id: item.id,
        output_index: item.outputIndex,
        summary_index: 0,
        part: { type: "summary_text", text },
      }),
      this.emit("response.output_item.done", { output_index: item.outputIndex, item: completedItem }),
    ];
  }

  private startText(event: ResponseEvent): SSEEvent[] {
    const item = this.newItem(event.contentIndex!, "message", "msg");
    item.contentIndex = 0;
    return [
      this.emit("response.output_item.added", {
        output_index: item.outputIndex,
        item: { id: item.id, type: "message", status: "in_progress", role: "assistant", content: [] },
      }),
      this.emit("response.content_part.added", {
        item_id: item.id,
        output_index: item.outputIndex,
        content_index: item.contentIndex,
        part: { type: "output_text", text: "", annotations: [], logprobs: [] },
      }),
    ];
  }

  private textDelta(event: ResponseEvent): SSEEvent[] {
    const item = this.item(event.contentIndex!, "message");
    item.value += event.delta!;
    return [
      this.emit("response.output_text.delta", {
        item_id: item.id,
        output_index: item.outputIndex,
        content_index: item.contentIndex,
        delta: event.delta,
        logprobs: [],
      }),
    ];
  }

  private endText(event: ResponseEvent): SSEEvent[] {
    const item = this.item(event.contentIndex!, "message");
    const text = event.content !== undefined && event.content !== "" ? event.content : item.value;
    const part: Json = { type: "output_text", text, annotations: [], logprobs: [] };
    const completedItem: Json = {
      id: item.id,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [part],
    };
    this.closeItem(item, completedItem);
    return [
      this.emit("response.output_text.done", {
        item_id: item.id,
        output_index: item.outputIndex,
        content_index: item.contentIndex,
        text,
        logprobs: [],
      }),
      this.emit("response.content_part.done", {
        item_id: item.id,
        output_index: item.outputIndex,
        content_index: item.contentIndex,
        part,
      }),
      this.emit("response.output_item.done", { output_index: item.outputIndex, item: completedItem }),
    ];
  }

  private startToolCall(event: ResponseEvent): SSEEvent[] {
    const item = this.newItem(event.contentIndex!, "function_call", "fc");
    item.callID = event.toolCallID!;
    item.name = event.toolName!;
    return [
      this.emit("response.output_item.added", {
        output_index: item.outputIndex,
        item: {
          id: item.id,
          type: "function_call",
          status: "in_progress",
          arguments: "",
          call_id: item.callID,
          name: item.name,
        },
      }),
    ];
  }

  private toolCallDelta(event: ResponseEvent): SSEEvent[] {
    const item = this.item(event.contentIndex!, "function_call");
    item.value += event.delta!;
    return [
      this.emit("response.function_call_arguments.delta", {
        item_id: item.id,
        output_index: item.outputIndex,
        delta: event.delta,
      }),
    ];
  }

  private endToolCall(event: ResponseEvent): SSEEvent[] {
    const item = this.item(event.contentIndex!, "function_call");
    let args = item.value;
    if (event.toolCall) {
      args = event.toolCall.arguments;
      item.callID = event.toolCall.id;
      item.name = event.toolCall.name;
    }
    const completedItem: Json = {
      id: item.id,
      type: "function_call",
      status: "completed",
      arguments: args,
      call_id: item.callID,
      name: item.name,
    };
    this.closeItem(item, completedItem);
    return [
      this.emit("response.function_call_arguments.done", {
        item_id: item.id,
        output_index: item.outputIndex,
        arguments: args,
      }),
      this.emit("response.output_item.done", { output_index: item.outputIndex, item: completedItem }),
    ];
  }

  private done(event: ResponseEvent): SSEEvent[] {
    for (const item of this.items.values()) {
      if (!item.closed) {
        throw new Error(`cannot finish response with open ${item.kind} item at output index ${item.outputIndex}`);
      }
    }
    this.completed = true;
    const response = baseResponse(this.responseID, this.model, this.createdAt, responseStatus(event.reason));
    response.output = this.completedOutput();
    response.usage = responseUsage(event.message!.usage);
    let eventName = "response.completed";
    if (event.reason === "length") {
      eventName = "response.incomplete";
      response.incomplete_details = { reason: "max_output_tokens" };
    } else {
      response.completed_at = Math.floor(Date.now() / 1000);
    }
    return [this.emit(eventName, { response })];
  }

  private failed(event: ResponseEvent): SSEEvent[] {
    this.completed = true;
    let message = "response stream failed";
    if (event.error?.errorMessage) message = event.error.errorMessage;
    const errorType = openAIErrorType(message);
    const response = baseResponse(this.responseID, this.model, this.createdAt, "failed");
    response.error = { message, type: errorType, code: null, param: null };
    return [
      this.emit("response.failed", {
        response,
        error: { message, type: errorType },
      }),
    ];
  }
}
