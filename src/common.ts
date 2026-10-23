// Shared request-content decoding + error type mapping — port of internal/api/common.

import type { Content, ImageContent } from "./llm.js";

export class DecodeError extends Error {}
export class ImageShapeError extends Error {}

const codexPermissionsBlock = /<permissions instructions>[\s\S]*?<\/permissions instructions>/g;

export function sanitizeText(text: string): string {
  return text.replace(codexPermissionsBlock, "");
}

export function contentText(content: Content[]): string {
  let out = "";
  for (const block of content) {
    if (block.type === "text") out += block.text;
  }
  return out;
}

// DecodeContent decodes a JSON string or part array into content blocks.
export function decodeContent(raw: unknown): Content[] {
  if (typeof raw === "string") {
    return [{ type: "text", text: sanitizeText(raw) }];
  }
  if (!Array.isArray(raw)) {
    throw new DecodeError("decode message content: content must be a string or part array");
  }
  const content: Content[] = [];
  for (let index = 0; index < raw.length; index++) {
    const part = raw[index] as { type?: string; text?: string };
    if (part === null || typeof part !== "object") {
      throw new DecodeError(`content[${index}]: invalid part`);
    }
    switch (part.type) {
      case "input_text":
      case "output_text":
      case "text":
        content.push({ type: "text", text: sanitizeText(typeof part.text === "string" ? part.text : "") });
        break;
      case "input_image":
      case "image_url":
      case "image":
        try {
          content.push(decodeImagePart(part));
        } catch (e) {
          throw new DecodeError(`content[${index}]: ${(e as Error).message}`);
        }
        break;
      default:
        // Unknown parts are ignored so IDE extra fields don't fail the request.
        continue;
    }
  }
  return content;
}

const isBlank = (v: unknown) => v === undefined || v === null;

export function decodeImagePart(part: Record<string, unknown>): ImageContent {
  const fileID = typeof part.file_id === "string" ? part.file_id : "";
  if (fileID !== "") {
    throw new DecodeError("file_id images are not supported; use base64 data URL in image_url");
  }
  for (const key of ["image_url", "image", "source"] as const) {
    const candidate = part[key];
    if (isBlank(candidate)) continue;
    try {
      return decodeImageValue(candidate);
    } catch (e) {
      if (!(e instanceof ImageShapeError)) throw e;
    }
  }
  if (typeof part.url === "string" && part.url !== "") return decodeDataImage(part.url);
  if (typeof part.data === "string" && part.data !== "") return decodeDataImage(part.data);
  throw new DecodeError("image part missing image_url/url/data (base64 data URL required)");
}

export function decodeImageValue(raw: unknown): ImageContent {
  if (typeof raw === "string") return decodeDataImage(raw);
  if (raw === null || typeof raw !== "object") throw new ImageShapeError("unrecognized image value shape");
  const obj = raw as Record<string, unknown>;
  if (typeof obj.file_id === "string" && obj.file_id !== "") {
    throw new DecodeError("file_id images are not supported; use base64 data URL");
  }
  if (typeof obj.url === "string" && obj.url !== "") return decodeDataImage(obj.url);
  let encoded = "";
  for (const key of ["data", "base64", "b64_json"] as const) {
    if (typeof obj[key] === "string" && (obj[key] as string) !== "") {
      encoded = obj[key] as string;
      break;
    }
  }
  if (encoded === "") throw new ImageShapeError("unrecognized image value shape");
  let mimeType = "";
  if (typeof obj.mime_type === "string") mimeType = obj.mime_type;
  if (mimeType === "" && typeof obj.media_type === "string") mimeType = obj.media_type;
  if (encoded.startsWith("data:")) return decodeDataImage(encoded);
  if (mimeType === "") mimeType = sniffImageMIME(encoded);
  if (mimeType === "") {
    throw new DecodeError("image base64 requires mime_type/media_type or data URL prefix");
  }
  return decodeRawBase64(encoded, mimeType);
}

const stripWhitespace = (s: string) => s.replace(/[\n\r \t]/g, "");

export function decodeDataImage(value: string): ImageContent {
  value = value.trim();
  if (value === "") throw new DecodeError("image url/data is empty");
  if (value.startsWith("http://") || value.startsWith("https://")) {
    throw new DecodeError("http(s) image URLs are not fetched yet; embed as data:image/...;base64,...");
  }
  if (!value.startsWith("data:")) {
    const mimeType = sniffImageMIME(value);
    if (mimeType !== "") return decodeRawBase64(value, mimeType);
    throw new DecodeError("only data URL or raw base64 images are supported");
  }
  const comma = value.indexOf(",");
  if (comma < 0) throw new DecodeError("image must be a base64 data URL");
  const meta = value.slice("data:".length, comma);
  const encoded = value.slice(comma + 1);
  const isBase64 = meta.includes(";base64") || !meta.includes(";");
  let mimeType = meta;
  const semi = mimeType.indexOf(";");
  if (semi >= 0) mimeType = mimeType.slice(0, semi);
  mimeType = mimeType.trim();
  if (mimeType === "") mimeType = "image/png";
  if (!/^[-\w.+]+\/[-\w.+]+$/.test(mimeType)) {
    throw new DecodeError(`invalid image MIME type: ${mimeType}`);
  }
  if (!isBase64) throw new DecodeError("image data URL must be base64 encoded");
  return decodeRawBase64(encoded, mimeType);
}

function b64decode(encoded: string): Uint8Array {
  const clean = stripWhitespace(encoded);
  const normalized = clean.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(normalized);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64encode(data: Uint8Array): string {
  let bin = "";
  for (const byte of data) bin += String.fromCharCode(byte);
  return btoa(bin);
}

export function decodeRawBase64(encoded: string, mimeType: string): ImageContent {
  let data: Uint8Array;
  try {
    data = b64decode(encoded);
  } catch (e) {
    throw new DecodeError(`decode image data: ${(e as Error).message}`);
  }
  if (data.length === 0) throw new DecodeError("image data is empty");
  return { type: "image", data: b64encode(data), mimeType };
}

export function sniffImageMIME(encoded: string): string {
  let raw: Uint8Array;
  try {
    raw = b64decode(encoded);
  } catch {
    return "";
  }
  if (raw.length >= 3 && raw[0] === 0xff && raw[1] === 0xd8 && raw[2] === 0xff) return "image/jpeg";
  if (raw.length >= 8 && raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4e && raw[3] === 0x47) return "image/png";
  if (raw.length >= 6 && raw[0] === 0x47 && raw[1] === 0x49 && raw[2] === 0x46) return "image/gif";
  if (
    raw.length >= 12 &&
    raw[0] === 0x52 && raw[1] === 0x49 && raw[2] === 0x46 && raw[3] === 0x46 &&
    raw[8] === 0x57 && raw[9] === 0x45 && raw[10] === 0x42 && raw[11] === 0x50
  ) {
    return "image/webp";
  }
  return "";
}

// RawOutputText treats tool output JSON as a string first, else returns raw JSON text.
export function rawOutputText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw === undefined || raw === null) throw new DecodeError("function call output is required");
  return JSON.stringify(raw);
}

// ---- error type mapping ----

const openAIErrorTypes: Record<string, string> = {
  invalid_argument: "invalid_request_error",
  failed_precondition: "invalid_request_error",
  out_of_range: "invalid_request_error",
  unimplemented: "invalid_request_error",
  unauthenticated: "authentication_error",
  permission_denied: "permission_error",
  not_found: "not_found_error",
  resource_exhausted: "rate_limit_error",
  deadline_exceeded: "timeout_error",
  unavailable: "server_error",
  internal: "server_error",
  unknown: "server_error",
};

const anthropicErrorTypes: Record<string, string> = {
  ...openAIErrorTypes,
  unavailable: "api_error",
  internal: "api_error",
  unknown: "api_error",
};

function extractErrorCode(message: string): string {
  const i = message.indexOf(":");
  return i >= 0 ? message.slice(0, i).trim() : "";
}

export function openAIErrorType(message: string): string {
  return openAIErrorTypes[extractErrorCode(message)] ?? "server_error";
}

export function anthropicErrorType(message: string): string {
  return anthropicErrorTypes[extractErrorCode(message)] ?? "api_error";
}
