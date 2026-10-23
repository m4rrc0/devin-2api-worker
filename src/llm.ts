// Provider-agnostic request/response model — port of internal/llm.

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";
export const StopReason = {
  Pending: "pending",
  Stop: "stop",
  Length: "length",
  ToolUse: "toolUse",
  Error: "error",
  Aborted: "aborted",
} as const;

export type TextContent = { type: "text"; text: string; textSignature?: string };
export type ThinkingContent = {
  type: "thinking";
  thinking: string;
  thinkingSignature: string;
  redacted: boolean;
};
export type ImageContent = { type: "image"; data: string; mimeType: string };
export type ToolCall = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: string; // JSON object text
  thoughtSignature?: string;
};
export type Content = TextContent | ThinkingContent | ImageContent | ToolCall;

export type UsageCost = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cost: UsageCost;
};
export const emptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

export type UserMessage = { role: "user"; content: Content[]; timestampMS: number };
export type AssistantMessage = {
  role: "assistant";
  content: Content[];
  api?: string;
  provider?: string;
  model?: string;
  responseModel?: string;
  responseID?: string;
  usage: Usage;
  stopReason?: StopReason;
  errorMessage?: string;
  timestampMS: number;
};
export type ToolResultMessage = {
  role: "toolResult";
  toolCallID: string;
  toolName: string;
  content: Content[];
  isError: boolean;
  timestampMS: number;
};
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export type ToolDefinition = { name: string; description: string; inputSchema: string };

export type RequestMessages = {
  model: string;
  systemPrompt: string;
  messages: Message[];
  tools: ToolDefinition[];
};

function isJSONObject(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function validateContent(content: Content[], allowed: Content["type"][], err: (m: string) => Error): void {
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (!block) throw err(`content block ${i} is nil`);
    if (!allowed.includes(block!.type)) {
      throw err(`content block ${i} has disallowed type "${block!.type}"`);
    }
    if (block!.type === "thinking" && block!.redacted && block!.thinkingSignature === "") {
      throw err("redacted thinking content requires a signature");
    }
    if (block!.type === "image") {
      if (block!.data === "") throw err("image data is required");
      if (block!.mimeType === "") throw err("image MIME type is required");
    }
    if (block!.type === "toolCall") {
      if (block!.id === "") throw err("tool call ID is required");
      if (block!.name === "") throw err("tool call name is required");
      if (!isJSONObject(block!.arguments)) throw err("tool call arguments must be a JSON object");
    }
  }
}

export function validateRequestMessages(request: RequestMessages): void {
  const err = (m: string) => new Error(m);
  for (let i = 0; i < request.messages.length; i++) {
    const message = request.messages[i];
    if (!message) throw new Error(`message ${i} is nil`);
    if (message.role === "user" || message.role === "toolResult") {
      validateContent(message.content, ["text", "image"], (m) => new Error(`message ${i} (${message.role}): ${m}`));
    } else {
      validateContent(message.content, ["text", "thinking", "toolCall"], (m) => new Error(`message ${i} (${message.role}): ${m}`));
    }
    if (message.role === "toolResult") {
      if (message.toolCallID === "") throw new Error(`message ${i} (toolResult): tool result call ID is required`);
      if (message.toolName === "") throw new Error(`message ${i} (toolResult): tool result name is required`);
    }
  }
  for (let i = 0; i < request.tools.length; i++) {
    const tool = request.tools[i]!;
    if (tool.name === "") throw new Error(`tool ${i}: tool name is required`);
    if (!isJSONObject(tool.inputSchema)) throw new Error(`tool ${i}: tool input schema must be a JSON object`);
  }
}

// ---- response events ----

export type ResponseEventType =
  | "start"
  | "text_start"
  | "text_delta"
  | "text_end"
  | "thinking_start"
  | "thinking_delta"
  | "thinking_end"
  | "toolcall_start"
  | "toolcall_delta"
  | "toolcall_end"
  | "done"
  | "error";

export type ResponseEvent = {
  type: ResponseEventType;
  contentIndex?: number;
  delta?: string;
  content?: string;
  partial?: AssistantMessage;
  toolCallID?: string;
  toolName?: string;
  toolCall?: ToolCall;
  reason?: StopReason;
  message?: AssistantMessage;
  error?: AssistantMessage;
};

export function validateEvent(event: ResponseEvent): void {
  const need = (m: string): never => {
    throw new Error(m);
  };
  const requirePartial = () => {
    if (!event.partial) need(`${event.type} event requires a partial message`);
  };
  const requireIndexed = () => {
    if (event.contentIndex === undefined || event.contentIndex < 0) {
      need(`${event.type} event requires a non-negative content index`);
    }
    requirePartial();
  };
  switch (event.type) {
    case "start":
      requirePartial();
      return;
    case "text_start":
    case "thinking_start":
      requireIndexed();
      return;
    case "toolcall_start":
      requireIndexed();
      if (!event.toolCallID) need("tool call start event requires a tool call ID");
      if (!event.toolName) need("tool call start event requires a tool name");
      return;
    case "text_delta":
    case "thinking_delta":
      requireIndexed();
      if (!event.delta) need("delta event requires a delta");
      return;
    case "toolcall_delta":
      requireIndexed();
      if (!event.toolCallID) need("tool call delta event requires a tool call ID");
      return;
    case "text_end":
    case "thinking_end":
      requireIndexed();
      return;
    case "toolcall_end":
      requireIndexed();
      if (!event.toolCall) need("tool call end event requires a tool call");
      return;
    case "done":
      if (event.reason !== "stop" && event.reason !== "length" && event.reason !== "toolUse") {
        need(`invalid done reason "${event.reason}"`);
      }
      if (!event.message) need("done event requires a final message");
      return;
    case "error":
      if (event.reason !== "error" && event.reason !== "aborted") {
        need(`invalid error reason "${event.reason}"`);
      }
      if (!event.error) need("error event requires a final error message");
      return;
    default:
      need(`unknown response event type "${event.type}"`);
  }
}
