// OpenAI Chat Completions protocol — port of internal/api/openai/chat.

import { DecodeError, contentText, decodeContent, openAIErrorType } from "./common.js";
import {
  emptyUsage,
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
  includeUsage: boolean;
  maxOutputTokens?: number;
  temperature?: number;
};

export type AdaptedRequest = { context: RequestMessages; options: RequestOptions };

type ChatMessage = {
  role?: string;
  content?: unknown;
  tool_calls?: { id?: string; type?: string; function?: { name?: string; arguments?: string } }[];
  tool_call_id?: string;
};

function isJSONObjectText(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

export function decodeRequest(data: string): AdaptedRequest {
  let request: {
    model?: string;
    messages?: ChatMessage[];
    tools?: { type?: string; function?: { name?: string; description?: string; parameters?: unknown } }[];
    stream?: boolean;
    stream_options?: { include_usage?: boolean };
    max_tokens?: number;
    max_completion_tokens?: number;
    temperature?: number;
  };
  try {
    request = JSON.parse(data);
  } catch (e) {
    throw new DecodeError(`decode chat request: ${(e as Error).message}`);
  }
  if (typeof request !== "object" || request === null) {
    throw new DecodeError("decode chat request: body must be a JSON object");
  }
  if (!request.model) throw new DecodeError("chat request model is required");
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new DecodeError("chat request messages are required");
  }
  const context: RequestMessages = { model: request.model, systemPrompt: "", messages: [], tools: [] };
  request.messages.forEach((message, index) => {
    try {
      appendMessage(context, message ?? {});
    } catch (e) {
      throw new DecodeError(`message[${index}]: ${(e as Error).message}`);
    }
  });
  for (const tool of request.tools ?? []) {
    if (tool.type !== "function") continue;
    const fn = tool.function ?? {};
    const schema =
      fn.parameters === undefined || fn.parameters === null ? '{"type":"object"}' : JSON.stringify(fn.parameters);
    context.tools.push({ name: fn.name ?? "", description: fn.description ?? "", inputSchema: schema });
  }
  try {
    validateRequestMessages(context);
  } catch (e) {
    throw new DecodeError(`validate adapted request: ${(e as Error).message}`);
  }
  const maxTokens = request.max_completion_tokens ?? request.max_tokens;
  return {
    context,
    options: {
      stream: request.stream === true,
      includeUsage: request.stream_options?.include_usage === true,
      maxOutputTokens: maxTokens,
      temperature: request.temperature,
    },
  };
}

function appendMessage(context: RequestMessages, message: ChatMessage): void {
  switch (message.role) {
    case "system":
    case "developer": {
      const text = contentText(decodeContent(message.content));
      if (context.systemPrompt !== "" && text !== "") context.systemPrompt += "\n";
      context.systemPrompt += text;
      return;
    }
    case "user": {
      const content =
        message.content === undefined || message.content === null
          ? [{ type: "text" as const, text: "" }]
          : decodeContent(message.content);
      context.messages.push({ role: "user", content, timestampMS: Date.now() });
      return;
    }
    case "assistant": {
      const content: Content[] = [];
      if (message.content !== undefined && message.content !== null) {
        content.push(...decodeContent(message.content));
      }
      for (const call of message.tool_calls ?? []) {
        if (call.type !== undefined && call.type !== "" && call.type !== "function") continue;
        const fn = call.function ?? {};
        const args = typeof fn.arguments === "string" && isJSONObjectText(fn.arguments) ? fn.arguments : "{}";
        content.push({ type: "toolCall", id: call.id ?? "", name: fn.name ?? "", arguments: args });
      }
      context.messages.push({ role: "assistant", content, usage: emptyUsage(), timestampMS: Date.now() });
      return;
    }
    case "tool": {
      const callID = message.tool_call_id ?? "";
      if (callID === "") throw new DecodeError("tool message requires tool_call_id");
      const content = decodeContent(message.content);
      const name = findToolName(context, callID);
      context.messages.push({
        role: "toolResult",
        toolCallID: callID,
        toolName: name,
        content,
        isError: false,
        timestampMS: Date.now(),
      });
      return;
    }
    default:
      // Unknown roles are ignored.
      return;
  }
}

function findToolName(context: RequestMessages, callID: string): string {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const m = context.messages[i]!;
    if (m.role !== "assistant") continue;
    for (const block of m.content) {
      if (block.type === "toolCall" && block.id === callID) return block.name;
    }
  }
  throw new DecodeError(`tool message references unknown tool_call_id "${callID}"`);
}

// ---- response encode ----

export type SSEEvent = { name: string; data: string };

type Json = Record<string, unknown>;

function newChatResponseID(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `chatcmpl-${hex}`;
}

function messageToChat(message: AssistantMessage): { messageObj: Json; toolCalls: Json[] } {
  let text = "";
  let reasoning = "";
  const toolCalls: Json[] = [];
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
    else if (block.type === "thinking") reasoning += block.thinking;
    else if (block.type === "toolCall") {
      toolCalls.push({ id: block.id, type: "function", function: { name: block.name, arguments: block.arguments } });
    }
  }
  const messageObj: Json = { role: "assistant", content: text };
  if (reasoning !== "") messageObj.reasoning_content = reasoning;
  if (toolCalls.length > 0) {
    messageObj.tool_calls = toolCalls;
    messageObj.content = null;
  }
  return { messageObj, toolCalls };
}

function chatUsage(usage: Usage): Json {
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  const total = usage.totalTokens !== 0 ? usage.totalTokens : inputTokens + usage.output;
  return {
    prompt_tokens: inputTokens,
    completion_tokens: usage.output,
    total_tokens: total,
    prompt_tokens_details: { cached_tokens: usage.cacheRead },
    completion_tokens_details: { reasoning_tokens: usage.reasoning ?? 0 },
  };
}

function finishReason(reason: StopReason | undefined): string | null {
  switch (reason) {
    case "toolUse":
      return "tool_calls";
    case "length":
      return "length";
    case "stop":
      return "stop";
    case "error":
    case "aborted":
      return "content_filter";
    default:
      return null;
  }
}

export function encodeResponse(message: AssistantMessage): Json {
  const model = message.responseModel || message.model || "devin";
  const { messageObj, toolCalls } = messageToChat(message);
  if (toolCalls.length > 0) messageObj.tool_calls = toolCalls;
  return {
    id: newChatResponseID(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: messageObj, finish_reason: finishReason(message.stopReason) }],
    usage: chatUsage(message.usage),
  };
}

// ---- stream encoder ----

type ToolCallState = { index: number; id: string; name: string; arguments: string; done: boolean };

export class StreamEncoder {
  private model: string;
  private responseID = newChatResponseID();
  private createdAt = Math.floor(Date.now() / 1000);
  private includeUsage: boolean;
  private textIndex = -1;
  private textStarted = false;
  private thinkingIndex = -1;
  private thinkingStarted = false;
  private toolCalls: ToolCallState[] = [];
  private finished = false;
  private finalUsage = emptyUsage();
  private finalReason: StopReason = "pending";

  constructor(model: string, includeUsage: boolean) {
    this.model = model;
    this.includeUsage = includeUsage;
  }

  encode(event: ResponseEvent): SSEEvent[] {
    switch (event.type) {
      case "start":
        return this.start();
      case "text_start":
        return this.startText(event);
      case "text_delta":
        return this.textDelta(event);
      case "text_end":
        return this.endText();
      case "thinking_start":
        return this.startThinking(event);
      case "thinking_delta":
        return this.thinkingDelta(event);
      case "thinking_end":
        return this.endThinking();
      case "toolcall_start":
        return this.startToolCall(event);
      case "toolcall_delta":
        return this.toolCallDelta(event);
      case "toolcall_end":
        return this.endToolCall(event);
      case "done":
        return this.finish(event);
      case "error":
        return this.failed(event);
      default:
        throw new Error(`unsupported response event type "${event.type}"`);
    }
  }

  private chunk(payload: Json): SSEEvent {
    payload.id = this.responseID;
    payload.object = "chat.completion.chunk";
    payload.created = this.createdAt;
    payload.model = this.model;
    if (!("usage" in payload)) payload.usage = null;
    return { name: "", data: JSON.stringify(payload) };
  }

  private choice(delta: Json, reason: string | null): SSEEvent {
    return this.chunk({ choices: [{ index: 0, delta, finish_reason: reason }] });
  }

  private start(): SSEEvent[] {
    return [this.choice({ role: "assistant" }, null)];
  }

  private startText(event: ResponseEvent): SSEEvent[] {
    this.textIndex = event.contentIndex!;
    this.textStarted = true;
    return [];
  }

  private textDelta(event: ResponseEvent): SSEEvent[] {
    if (!this.textStarted) this.startText(event);
    if (event.delta === "") return [];
    return [this.choice({ content: event.delta }, null)];
  }

  private endText(): SSEEvent[] {
    this.textStarted = false;
    return [];
  }

  private startThinking(event: ResponseEvent): SSEEvent[] {
    this.thinkingIndex = event.contentIndex!;
    this.thinkingStarted = true;
    return [];
  }

  private thinkingDelta(event: ResponseEvent): SSEEvent[] {
    if (!this.thinkingStarted) this.startThinking(event);
    if (event.delta === "") return [];
    return [this.choice({ reasoning_content: event.delta }, null)];
  }

  private endThinking(): SSEEvent[] {
    this.thinkingStarted = false;
    return [];
  }

  private startToolCall(event: ResponseEvent): SSEEvent[] {
    const state: ToolCallState = {
      index: this.toolCalls.length,
      id: event.toolCallID!,
      name: event.toolName!,
      arguments: "",
      done: false,
    };
    this.toolCalls.push(state);
    return [
      this.choice(
        {
          tool_calls: [
            { index: state.index, id: state.id, type: "function", function: { name: state.name, arguments: "" } },
          ],
        },
        null,
      ),
    ];
  }

  private toolCallDelta(event: ResponseEvent): SSEEvent[] {
    const state = this.findTool(event.toolCallID!, event.contentIndex!);
    if (!state) return [];
    state.arguments += event.delta!;
    return [
      this.choice(
        { tool_calls: [{ index: state.index, function: { arguments: event.delta } }] },
        null,
      ),
    ];
  }

  private endToolCall(event: ResponseEvent): SSEEvent[] {
    const state = this.findToolByIndex(event.contentIndex!);
    if (!state) return [];
    state.done = true;
    if (event.toolCall) {
      state.id = event.toolCall.id;
      state.name = event.toolCall.name;
      state.arguments = event.toolCall.arguments;
    }
    return [];
  }

  private finish(event: ResponseEvent): SSEEvent[] {
    this.finished = true;
    if (event.message) {
      this.finalUsage = event.message.usage;
      this.finalReason = event.message.stopReason ?? "pending";
    }
    const events = [this.choice({}, finishReason(event.reason))];
    if (this.includeUsage) {
      events.push(this.chunk({ choices: [], usage: chatUsage(this.finalUsage) }));
    }
    events.push({ name: "[DONE]", data: "[DONE]" });
    return events;
  }

  private failed(event: ResponseEvent): SSEEvent[] {
    this.finished = true;
    let message = "chat completion stream failed";
    if (event.error?.errorMessage) message = event.error.errorMessage;
    const data = JSON.stringify({
      id: this.responseID,
      object: "chat.completion.chunk",
      created: this.createdAt,
      model: this.model,
      choices: [],
      usage: null,
      error: { message, type: openAIErrorType(message), code: null, param: null },
    });
    return [{ name: "", data }];
  }

  private findTool(id: string, contentIndex: number): ToolCallState | undefined {
    for (const state of this.toolCalls) {
      if (state.id !== "" && state.id === id) return state;
      if (state.index === contentIndex) return state;
    }
    return undefined;
  }

  private findToolByIndex(contentIndex: number): ToolCallState | undefined {
    for (const state of this.toolCalls) {
      if (state.index === contentIndex) return state;
    }
    return undefined;
  }
}
