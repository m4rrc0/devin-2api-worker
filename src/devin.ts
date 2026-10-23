// Devin upstream adapter — port of internal/adapter/devin.
// Connect protocol over fetch: binary protobuf payloads, envelope framing for
// server-streaming, plain bodies for unary RPCs.

import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import type { DescMessage, MessageInitShape } from "@bufbuild/protobuf";
import type { Timestamp } from "@bufbuild/protobuf/wkt";
import {
  GetChatMessageRequestSchema,
  GetChatMessageResponseSchema,
  GetCascadeModelConfigsRequestSchema,
  GetCascadeModelConfigsResponseSchema,
  ChatMessageRequestType,
  type GetChatMessageRequest,
  type GetChatMessageResponse,
  type GetCascadeModelConfigsResponse,
} from "./gen/exa/api_server_pb/api_server_pb.js";
import {
  ChatMessageSource,
  ConversationalPlannerMode,
  ModelProvider,
  StopReason as PbStopReason,
  type ChatToolCall,
} from "./gen/exa/codeium_common_pb/codeium_common_pb.js";
import { CortexTrajectoryType, CortexStepType } from "./gen/exa/cortex_pb/cortex_pb.js";
import { ChatMessagePromptSchema, type ChatMessagePrompt } from "./gen/exa/chat_pb/chat_pb.js";
import {
  emptyUsage,
  validateRequestMessages,
  type AssistantMessage,
  type Content,
  type RequestMessages,
  type ResponseEvent,
  type StopReason,
  type ToolCall,
} from "./llm.js";

export const CLIENT_NAME = "chisel";
export const CLIENT_VERSION = "3000.2.17";

export type DevinConfig = {
  baseUrl: string;
  token: string;
  model: string;
};

export type ModelInfo = {
  id: string;
  created: number;
  ownedBy: string;
  supportsImages: boolean;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class UpstreamError extends Error {}

// ---- Connect wire helpers ----

const CONNECT_STREAM_FLAGS_END = 0x02;
const CONNECT_STREAM_FLAGS_COMPRESSED = 0x01;

export function encodeEnvelope(payload: Uint8Array, flags = 0): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = flags;
  new DataView(frame.buffer).setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
}

export type Envelope = { flags: number; payload: Uint8Array };

// decodeEnvelopes incrementally parses a byte stream into Connect frames.
export async function* decodeEnvelopes(body: ReadableStream<Uint8Array>): AsyncGenerator<Envelope> {
  const reader = body.getReader();
  let buffer = new Uint8Array(0);
  const push = (chunk: Uint8Array) => {
    const next = new Uint8Array(buffer.length + chunk.length);
    next.set(buffer, 0);
    next.set(chunk, buffer.length);
    buffer = next;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length > 0) push(value);
    while (buffer.length >= 5) {
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const flags = view.getUint8(0);
      const length = view.getUint32(1, false);
      if (buffer.length < 5 + length) break;
      yield { flags, payload: buffer.slice(5, 5 + length) };
      buffer = buffer.slice(5 + length);
    }
  }
  if (buffer.length > 0) {
    throw new UpstreamError("unknown: truncated connect stream frame");
  }
}

// parseConnectErrorBody maps a connect unary error JSON body to "code: message".
export function parseConnectErrorBody(text: string, status: number): string {
  try {
    const parsed = JSON.parse(text) as { code?: string; message?: string };
    if (parsed && typeof parsed.code === "string") {
      const message = typeof parsed.message === "string" && parsed.message !== "" ? parsed.message : text;
      return `${parsed.code}: ${message}`;
    }
  } catch {
    // fall through
  }
  return `unknown: HTTP ${status}: ${text.slice(0, 500)}`;
}

// ---- tool definitions (port of tool_definition.go) ----

const descriptionListItemPattern = /^(?:[-*+]\s+|\d+[.):]\s+|\[\d+\]\s+)(.+)$/;

function isJSONObjectText(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function isSentenceTerminator(c: string): boolean {
  return c === "." || c === "!" || c === "?" || c === "。" || c === "！" || c === "？";
}

const ABBREVIATIONS = new Set(["e.g.", "i.e.", "etc.", "vs.", "mr.", "mrs.", "dr.", "prof.", "no."]);

function endsWithAbbreviation(fragment: string): boolean {
  const fields = fragment.toLowerCase().split(/\s+/).filter(Boolean);
  if (fields.length === 0) return false;
  const word = fields[fields.length - 1]!.replace(/^["'()\[\]{}]+|["'()\[\]{}]+$/g, "");
  return ABBREVIATIONS.has(word);
}

export function splitDescriptionSentences(paragraph: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  const len = paragraph.length;
  let offset = 0;
  while (offset < len) {
    const character = paragraph[offset]!;
    const end = offset + 1;
    if (isSentenceTerminator(character)) {
      let next = end;
      while (next < len && /\s/.test(paragraph[next]!)) next++;
      const hasSentenceBoundary = next > end || character === "。" || character === "！" || character === "？";
      if (hasSentenceBoundary && next < len && !endsWithAbbreviation(paragraph.slice(start, end))) {
        sentences.push(paragraph.slice(start, end).trim());
        start = next;
        offset = next;
        continue;
      }
    }
    offset = end;
  }
  const remaining = paragraph.slice(start).trim();
  if (remaining !== "") sentences.push(remaining);
  return sentences;
}

function isValidJSONText(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

export function formatToolDescription(description: string): string {
  description = description.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = description.split("\n");
  const output: string[] = [];
  let prose: string[] = [];
  let itemNumber = 1;
  let inCodeFence = false;

  const appendSentences = (value: string) => {
    for (const sentence of splitDescriptionSentences(value)) {
      output.push(`${itemNumber}. ${sentence}`);
      itemNumber++;
    }
  };
  const appendBlankLine = () => {
    if (output.length > 0 && output[output.length - 1] !== "") output.push("");
  };
  const flushProse = () => {
    if (prose.length === 0) return;
    const paragraph = prose.join("\n").trim();
    prose = [];
    if (paragraph === "") return;
    if (isValidJSONText(paragraph)) {
      output.push(paragraph);
      return;
    }
    appendSentences(paragraph);
  };

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith("```") || trimmedLine.startsWith("~~~")) {
      flushProse();
      output.push(line);
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) {
      output.push(line);
      continue;
    }
    if (trimmedLine === "") {
      flushProse();
      appendBlankLine();
      continue;
    }
    const listItem = descriptionListItemPattern.exec(trimmedLine);
    if (listItem) {
      flushProse();
      appendSentences(listItem[1]!.trim());
      continue;
    }
    prose.push(line);
  }
  flushProse();
  return output.join("\n").trim();
}

function escapeXMLAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\t/g, "&#x9;")
    .replace(/\n/g, "&#xA;")
    .replace(/\r/g, "&#xD;");
}

function escapeXMLText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function withToolDescriptions(systemPrompt: string, tools: { name: string; description: string }[]): string {
  let section = "";
  for (const tool of tools) {
    const description = tool.description.trim();
    if (description === "") continue;
    if (section === "") section = "# tools descriptions";
    section += `\n<tool name="${escapeXMLAttribute(tool.name)}">\n${escapeXMLText(formatToolDescription(description))}\n</tool>`;
  }
  if (section === "") return systemPrompt;
  const trimmedPrompt = systemPrompt.replace(/[\r\n]+$/, "");
  if (trimmedPrompt.trim() === "") return section;
  return `${trimmedPrompt}\n\n${section}`;
}

const SCHEMA_LITERAL_KEYS = new Set(["const", "default", "enum", "example", "examples"]);

function isNaturalLanguageAnnotation(key: string): boolean {
  if (key === "description" || key === "title" || key === "$comment") return true;
  return key.toLowerCase().startsWith("x-");
}

function stripSchemaValueAnnotations(value: unknown, propertyNames: boolean): unknown {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = stripSchemaValueAnnotations(value[i], false);
    }
    return value;
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(source)) {
      if (isNaturalLanguageAnnotation(key) && !propertyNames) continue;
      if (SCHEMA_LITERAL_KEYS.has(key) && !propertyNames) {
        cleaned[key] = child;
        continue;
      }
      cleaned[key] = stripSchemaValueAnnotations(child, key === "properties");
    }
    return cleaned;
  }
  return value;
}

export function stripSchemaAnnotations(schema: string): string {
  const value: unknown = JSON.parse(schema);
  return JSON.stringify(stripSchemaValueAnnotations(value, false));
}

function convertToolDefinition(tool: { name: string; inputSchema: string }): { name: string; description: string; jsonSchemaString: string } {
  let schema: string;
  try {
    schema = stripSchemaAnnotations(tool.inputSchema);
  } catch (e) {
    throw new Error(`sanitize Devin tool "${tool.name}" schema: ${(e as Error).message}`);
  }
  return { name: tool.name, description: tool.name, jsonSchemaString: schema };
}

// ---- randomness ----

export function randomUUID(): string {
  return crypto.randomUUID();
}

export function randomHex(size: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

// ---- image support ----

const NO_VISION_PREFIXES = ["glm-5-2", "glm-5", "glm-4.7", "glm-4-7", "glm-4", "deepseek", "kimi-k2", "qwen3-coder"];

export function modelLikelySupportsImages(model: string): boolean {
  const m = model.toLowerCase().trim();
  if (m === "") return true;
  for (const p of NO_VISION_PREFIXES) {
    if (m === p || m.startsWith(p + "-") || m.startsWith(p + "_")) return false;
  }
  if (m.startsWith("o1") || m.startsWith("o3-mini") || m.startsWith("o4-mini")) return false;
  return true;
}

function requestHasImages(request: RequestMessages): boolean {
  for (const message of request.messages) {
    if (message.role !== "user" && message.role !== "toolResult") continue;
    for (const block of message.content) {
      if (block.type === "image") return true;
    }
  }
  return false;
}

function validateImagesForModel(request: RequestMessages, model: string): void {
  if (!requestHasImages(request)) return;
  if (!modelLikelySupportsImages(model)) {
    throw new Error(
      `invalid_argument: model "${model}" does not support image inputs (supports_images=false); use a vision-capable model or remove images`,
    );
  }
}

// ---- request building ----

type PromptInit = MessageInitShape<typeof ChatMessagePromptSchema>;

function promptForContent(source: ChatMessageSource, content: Content[], attachImages: boolean): PromptInit {
  const prompt: PromptInit = {
    messageId: randomUUID(),
    source,
    prompt: "",
    toolCalls: [],
    images: [],
  };
  let text = "";
  const images: { base64Data: string; mimeType: string }[] = [];
  for (const block of content) {
    if (block.type === "text") {
      text += block.text;
    } else if (block.type === "thinking") {
      prompt.thinking = block.thinking;
      if (block.thinkingSignature !== "") prompt.signature = block.thinkingSignature;
      prompt.thinkingRedacted = block.redacted;
    } else if (block.type === "image") {
      if (!attachImages) {
        if (text.length > 0) text += "\n";
        text += "[Image omitted from history]";
        continue;
      }
      let data = block.data;
      if (data.startsWith("data:")) {
        const comma = data.indexOf(",");
        if (comma >= 0) data = data.slice(comma + 1);
      }
      images.push({ base64Data: data, mimeType: block.mimeType === "" ? "image/png" : block.mimeType });
    }
  }
  prompt.prompt = text;
  prompt.images = images;
  return prompt;
}

function convertMessage(
  message: RequestMessages["messages"][number],
  attachImages: boolean,
): PromptInit[] {
  if (message.role === "user") {
    return [promptForContent(ChatMessageSource.USER, message.content, attachImages)];
  }
  if (message.role === "assistant") {
    const prompt = promptForContent(ChatMessageSource.SYSTEM, message.content, false);
    const toolCalls: { id: string; name: string; argumentsJson: string }[] = [];
    for (const block of message.content) {
      if (block.type === "toolCall") {
        toolCalls.push({ id: block.id, name: block.name, argumentsJson: block.arguments });
      }
    }
    prompt.toolCalls = toolCalls;
    return [prompt];
  }
  if (message.role === "toolResult") {
    const prompt = promptForContent(ChatMessageSource.TOOL, message.content, attachImages);
    prompt.toolCallId = message.toolCallID;
    prompt.toolResultIsError = message.isError;
    return [prompt];
  }
  throw new Error(`unsupported message role "${(message as { role: string }).role}"`);
}

export function buildRequest(request: RequestMessages, config: DevinConfig): GetChatMessageRequest {
  const metadata = {
    apiKey: config.token,
    extensionName: CLIENT_NAME,
    extensionVersion: CLIENT_VERSION,
    ideName: CLIENT_NAME,
    ideVersion: CLIENT_VERSION,
    locale: "en",
    os: "mac",
    f: randomHex(366),
  };
  const init: MessageInitShape<typeof GetChatMessageRequestSchema> = {
    metadata,
    prompt: withToolDescriptions(request.systemPrompt, request.tools),
    chatModelUid: config.model,
    requestType: ChatMessageRequestType.CASCADE,
    configuration: {
      numCompletions: 1n,
      maxTokens: 128000n,
      maxNewlines: 400n,
      temperature: 1,
      topK: 40n,
      topP: 0.95,
    },
    trajectoryReference: {
      trajectoryId: randomUUID(),
      trajectoryType: CortexTrajectoryType.CASCADE,
      stepType: CortexStepType.USER_INPUT,
    },
    cascadeId: randomUUID(),
    plannerMode: ConversationalPlannerMode.DEFAULT,
    executionId: randomUUID(),
    chatMessagePrompts: [],
    tools: [],
  };
  let lastAssistantIndex = -1;
  for (let i = 0; i < request.messages.length; i++) {
    if (request.messages[i]!.role === "assistant") lastAssistantIndex = i;
  }
  for (let i = 0; i < request.messages.length; i++) {
    init.chatMessagePrompts!.push(...convertMessage(request.messages[i]!, i > lastAssistantIndex));
  }
  for (const tool of request.tools) {
    init.tools!.push(convertToolDefinition(tool));
  }
  return create(GetChatMessageRequestSchema, init);
}

// ---- response decoding (port of response_decoder.go) ----

function mapStopReason(reason: PbStopReason): StopReason {
  switch (reason) {
    case PbStopReason.MAX_TOKENS:
    case PbStopReason.INCOMPLETE:
    case PbStopReason.PARTIAL:
      return "length";
    case PbStopReason.FUNCTION_CALL:
      return "toolUse";
    case PbStopReason.ERROR:
      return "error";
    default:
      return "stop";
  }
}

type ToolState = {
  call: ToolCall;
  contentIdx: number;
  arguments: string;
  emitted: boolean;
};

export class ResponseDecoder {
  model: string;
  partial: AssistantMessage = {
    role: "assistant",
    content: [],
    api: "connect",
    provider: "devin",
    model: "",
    usage: emptyUsage(),
    stopReason: "pending",
    timestampMS: Date.now(),
  };
  private text = "";
  private textIdx = 0;
  private textOpen = false;
  private thinking = "";
  private thinkingSignature = "";
  private thinkingRedacted = false;
  private thinkIdx = 0;
  private thinkingOpen = false;
  private tools: ToolState[] = [];
  private started = false;
  finished = false;
  private hasStopReason = false;
  private stopReason: StopReason = "pending";

  constructor(model: string) {
    this.model = model;
  }

  start(): ResponseEvent[] {
    if (this.started || this.finished) return [];
    this.started = true;
    this.partial.model = this.model;
    return [{ type: "start", partial: this.partial }];
  }

  decode(response: GetChatMessageResponse): ResponseEvent[] {
    if (!response || this.finished) return [];
    this.updateMetadata(response);
    const events: ResponseEvent[] = [];
    if (response.deltaThinking !== "" || response.deltaSignature !== "" || response.thinkingRedacted) {
      events.push(...this.endText(), ...this.decodeThinking(response));
    }
    if (response.deltaText !== "") {
      events.push(...this.endThinking(), ...this.decodeText(response.deltaText));
    }
    for (const delta of response.deltaToolCalls) {
      events.push(...this.endThinking(), ...this.endText(), ...this.decodeTool(delta));
    }
    if (response.stopReason !== PbStopReason.UNSPECIFIED) {
      this.hasStopReason = true;
      this.stopReason = mapStopReason(response.stopReason);
    }
    return events;
  }

  finish(upstreamErr?: Error): ResponseEvent[] {
    if (this.finished) return [];
    if (upstreamErr) return this.fail(upstreamErr);
    if (!this.hasStopReason && this.partial.content.length === 0 && this.tools.length === 0) {
      return this.fail(new Error("Devin stream ended without generated content"));
    }
    let reason = this.stopReason;
    if (!this.hasStopReason) reason = "stop";
    if (reason === "error") return this.fail(new Error("Devin stopped with an error"));
    return this.complete(reason);
  }

  private updateMetadata(response: GetChatMessageResponse): void {
    if (response.messageId !== "") this.partial.responseID = response.messageId;
    if (response.actualModelUid !== undefined) this.partial.responseModel = response.actualModelUid;
    const timestamp = response.timestamp as Timestamp | undefined;
    if (timestamp) {
      this.partial.timestampMS = Number(timestamp.seconds) * 1000 + Math.floor(timestamp.nanos / 1e6);
    }
    const usage = response.usage;
    if (usage) {
      if ((this.partial.responseModel === undefined || this.partial.responseModel === "") && usage.modelUid !== "") {
        this.partial.responseModel = usage.modelUid;
      }
      if (usage.inputTokens !== 0n) this.partial.usage.input = Number(usage.inputTokens);
      if (usage.outputTokens !== 0n) this.partial.usage.output = Number(usage.outputTokens);
      if (usage.cacheReadTokens !== 0n) this.partial.usage.cacheRead = Number(usage.cacheReadTokens);
      if (usage.cacheWriteTokens !== 0n) this.partial.usage.cacheWrite = Number(usage.cacheWriteTokens);
      this.partial.usage.totalTokens =
        this.partial.usage.input + this.partial.usage.output + this.partial.usage.cacheRead + this.partial.usage.cacheWrite;
    }
  }

  private decodeThinking(response: GetChatMessageResponse): ResponseEvent[] {
    const events: ResponseEvent[] = [];
    if (!this.thinkingOpen) {
      this.thinking = "";
      this.thinkingSignature = "";
      this.thinkingRedacted = response.thinkingRedacted;
      this.partial.content.push({ type: "thinking", thinking: "", thinkingSignature: "", redacted: this.thinkingRedacted });
      this.thinkIdx = this.partial.content.length - 1;
      this.thinkingOpen = true;
      events.push({ type: "thinking_start", contentIndex: this.thinkIdx, partial: this.partial });
    }
    if (response.deltaThinking !== "") this.thinking += response.deltaThinking;
    if (response.deltaSignature !== "") this.thinkingSignature += response.deltaSignature;
    this.thinkingRedacted = this.thinkingRedacted || response.thinkingRedacted;
    const thinkBlock = this.partial.content[this.thinkIdx] as { type: "thinking"; thinkingSignature: string; redacted: boolean };
    thinkBlock.thinkingSignature = this.thinkingSignature;
    thinkBlock.redacted = this.thinkingRedacted;
    if (response.deltaThinking !== "") {
      events.push({ type: "thinking_delta", contentIndex: this.thinkIdx, delta: response.deltaThinking, partial: this.partial });
    }
    return events;
  }

  private decodeText(delta: string): ResponseEvent[] {
    const events: ResponseEvent[] = [];
    if (!this.textOpen) {
      this.text = "";
      this.partial.content.push({ type: "text", text: "" });
      this.textIdx = this.partial.content.length - 1;
      this.textOpen = true;
      events.push({ type: "text_start", contentIndex: this.textIdx, partial: this.partial });
    }
    this.text += delta;
    events.push({ type: "text_delta", contentIndex: this.textIdx, delta, partial: this.partial });
    return events;
  }

  private decodeTool(delta: ChatToolCall): ResponseEvent[] {
    let state = this.findTool(delta.id);
    if (!state) {
      state = { call: { type: "toolCall", id: delta.id, name: delta.name, arguments: "{}" }, contentIdx: -1, arguments: "", emitted: false };
      this.tools.push(state);
    }
    if (delta.id !== "") state.call.id = delta.id;
    if (delta.name !== "") state.call.name = delta.name;
    const fragment = delta.argumentsJson;
    const hasFragment = fragment !== "";
    if (hasFragment) state.arguments += fragment;
    const events: ResponseEvent[] = [];
    if (!state.emitted) {
      state.contentIdx = this.partial.content.length;
      state.emitted = true;
      this.partial.content.push(state.call);
      events.push({
        type: "toolcall_start",
        contentIndex: state.contentIdx,
        toolCallID: state.call.id,
        toolName: state.call.name,
        partial: this.partial,
      });
    }
    if (hasFragment) {
      events.push({
        type: "toolcall_delta",
        contentIndex: state.contentIdx,
        toolCallID: state.call.id,
        delta: fragment,
        partial: this.partial,
      });
    }
    return events;
  }

  private findTool(id: string): ToolState | undefined {
    for (const state of this.tools) {
      if (id !== "" && state.call.id === id) return state;
    }
    if (id === "" && this.tools.length > 0) return this.tools[this.tools.length - 1];
    return undefined;
  }

  private endThinking(): ResponseEvent[] {
    if (!this.thinkingOpen) return [];
    this.thinkingOpen = false;
    const block = this.partial.content[this.thinkIdx] as { type: "thinking"; thinking: string; thinkingSignature: string };
    block.thinking = this.thinking;
    block.thinkingSignature = this.thinkingSignature;
    return [{ type: "thinking_end", contentIndex: this.thinkIdx, content: this.thinking, partial: this.partial }];
  }

  private endText(): ResponseEvent[] {
    if (!this.textOpen) return [];
    this.textOpen = false;
    (this.partial.content[this.textIdx] as { type: "text"; text: string }).text = this.text;
    return [{ type: "text_end", contentIndex: this.textIdx, content: this.text, partial: this.partial }];
  }

  private complete(reason: StopReason): ResponseEvent[] {
    if (this.finished) return [];
    const events: ResponseEvent[] = [];
    this.partial.stopReason = reason;
    events.push(...this.endThinking(), ...this.endText());
    for (const state of this.tools) {
      if (!state.emitted) continue;
      state.call.arguments = state.arguments;
      if (!isJSONObjectText(state.call.arguments)) state.call.arguments = "{}";
      this.partial.content[state.contentIdx] = state.call;
      events.push({ type: "toolcall_end", contentIndex: state.contentIdx, toolCall: state.call, partial: this.partial });
    }
    events.push({ type: "done", reason, message: this.partial });
    this.finished = true;
    return events;
  }

  private fail(err: Error): ResponseEvent[] {
    if (this.finished) return [];
    this.partial.stopReason = "error";
    this.partial.errorMessage = err.message;
    this.finished = true;
    return [{ type: "error", reason: "error", error: this.partial }];
  }
}

// ---- HTTP adapter ----

const API_SERVER = "exa.api_server_pb.ApiServerService";

function authHeaders(token: string, contentType: string): Record<string, string> {
  return {
    authorization: `Basic ${token}-${token}`,
    "content-type": contentType,
    "connect-protocol-version": "1",
    "connect-accept-encoding": "identity",
  };
}

export class DevinAdapter {
  private config: DevinConfig;
  private fetchImpl: FetchLike;
  private modelsCache: { models: ModelInfo[]; expiry: number } | undefined;
  private modelsCacheTTLms = 5 * 60 * 1000;
  private inflightModels: Promise<ModelInfo[]> | undefined;

  constructor(config: DevinConfig, fetchImpl?: FetchLike) {
    if (config.baseUrl.trim() === "") throw new Error("devin base URL is required");
    if (config.token.trim() === "") throw new Error("devin token is required");
    this.config = config;
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private url(method: string): string {
    return `${this.config.baseUrl.replace(/\/+$/, "")}/${API_SERVER}/${method}`;
  }

  async unary<Desc extends DescMessage>(
    method: string,
    resSchema: Desc,
    body: Uint8Array,
  ): Promise<import("@bufbuild/protobuf").MessageShape<Desc>> {
    const response = await this.fetchImpl(this.url(method), {
      method: "POST",
      headers: authHeaders(this.config.token, "application/proto"),
      body,
    });
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (!response.ok) {
      throw new UpstreamError(parseConnectErrorBody(new TextDecoder().decode(buffer), response.status));
    }
    return fromBinary(resSchema, buffer);
  }

  // stream returns the decoded intermediate response events for one request.
  async *stream(request: RequestMessages): AsyncGenerator<ResponseEvent> {
    validateRequestMessages(request);
    let model = request.model.trim();
    if (model === "") model = this.config.model;
    validateImagesForModel(request, model);
    const protoRequest = buildRequest(request, { ...this.config, model });
    const decoder = new ResponseDecoder(model);
    let response: Response;
    try {
      response = await this.fetchImpl(this.url("GetChatMessage"), {
        method: "POST",
        headers: authHeaders(this.config.token, "application/connect+proto"),
        body: encodeEnvelope(toBinary(GetChatMessageRequestSchema, protoRequest)),
      });
    } catch (e) {
      throw new UpstreamError(`unavailable: ${(e as Error).message}`);
    }
    if (!response.ok) {
      const text = await response.text();
      throw new UpstreamError(parseConnectErrorBody(text, response.status));
    }
    if (!response.body) {
      throw new UpstreamError("unknown: empty upstream response body");
    }
    yield* decoder.start();
    let upstreamErr: Error | undefined;
    let sawEnd = false;
    try {
      for await (const frame of decodeEnvelopes(response.body)) {
        if ((frame.flags & CONNECT_STREAM_FLAGS_END) !== 0) {
          sawEnd = true;
          const end = JSON.parse(new TextDecoder().decode(frame.payload)) as {
            error?: { code?: string; message?: string };
          };
          if (end.error) {
            upstreamErr = new UpstreamError(`${end.error.code ?? "unknown"}: ${end.error.message ?? ""}`.trim());
          }
          break;
        }
        if ((frame.flags & CONNECT_STREAM_FLAGS_COMPRESSED) !== 0) {
          upstreamErr = new UpstreamError("internal: unexpected compressed frame");
          break;
        }
        const message = fromBinary(GetChatMessageResponseSchema, frame.payload);
        yield* decoder.decode(message);
        if (decoder.finished) return;
      }
    } catch (e) {
      upstreamErr = e instanceof Error ? e : new Error(String(e));
    }
    void sawEnd;
    yield* decoder.finish(upstreamErr);
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.modelsCache && Date.now() < this.modelsCache.expiry) return this.modelsCache.models;
    this.inflightModels ??= this.fetchModels().finally(() => {
      this.inflightModels = undefined;
    });
    return this.inflightModels;
  }

  private async fetchModels(): Promise<ModelInfo[]> {
    if (this.modelsCache && Date.now() < this.modelsCache.expiry) return this.modelsCache.models;
    const body = toBinary(
      GetCascadeModelConfigsRequestSchema,
      create(GetCascadeModelConfigsRequestSchema, {
        metadata: {
          apiKey: this.config.token,
          extensionName: CLIENT_NAME,
          extensionVersion: CLIENT_VERSION,
          ideName: CLIENT_NAME,
          ideVersion: CLIENT_VERSION,
          locale: "en",
          os: "win",
        },
      }),
    );
    let resp: GetCascadeModelConfigsResponse;
    try {
      resp = await this.unary("GetCascadeModelConfigs", GetCascadeModelConfigsResponseSchema, body);
    } catch (e) {
      throw new Error(`Devin GetCascadeModelConfigs: ${(e as Error).message}`);
    }
    const now = Math.floor(Date.now() / 1000);
    const models: ModelInfo[] = [];
    const seen = new Set<string>();
    for (const c of resp.clientModelConfigs) {
      if (c.disabled) continue;
      let uid = c.modelUid;
      if (uid === "" && c.modelOrAlias && c.modelOrAlias.choice.case === "modelUid") uid = c.modelOrAlias.choice.value;
      if (uid === "" || seen.has(uid)) continue;
      seen.add(uid);
      let ownedBy = "devin";
      const providerName = ModelProvider[c.provider];
      if (typeof providerName === "string" && providerName !== "") {
        const i = providerName.lastIndexOf("_");
        if (i >= 0 && i + 1 < providerName.length) ownedBy = providerName.slice(i + 1).toLowerCase();
      }
      models.push({ id: uid, created: now, ownedBy, supportsImages: c.supportsImages });
    }
    const configured = this.config.model.trim();
    if (configured !== "" && !seen.has(configured)) {
      models.push({ id: configured, created: now, ownedBy: "devin", supportsImages: true });
    }
    // Don't overwrite a fresher cache written while this fetch was in flight.
    if (this.modelsCache && Date.now() < this.modelsCache.expiry) return this.modelsCache.models;
    this.modelsCache = { models, expiry: Date.now() + this.modelsCacheTTLms };
    return models;
  }
}

export type { ChatMessagePrompt };
