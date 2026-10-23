import { describe, it, expect } from "vitest";
import { decodeContent, decodeImagePart, decodeDataImage, sniffImageMIME, rawOutputText, openAIErrorType, anthropicErrorType, sanitizeText, DecodeError } from "../src/common.js";

const PNG_B64 = btoa("\x89PNG\r\n\x1a\n" + "x".repeat(20));
const JPEG_B64 = btoa("\xff\xd8\xff" + "x".repeat(20));

describe("decodeContent", () => {
  it("decodes a plain string into one text block", () => {
    expect(decodeContent("hello")).toEqual([{ type: "text", text: "hello" }]);
  });
  it("decodes text parts", () => {
    const out = decodeContent([{ type: "text", text: "a" }, { type: "input_text", text: "b" }]);
    expect(out).toEqual([{ type: "text", text: "a" }, { type: "text", text: "b" }]);
  });
  it("skips unknown part types", () => {
    expect(decodeContent([{ type: "weird", x: 1 }, { type: "text", text: "ok" }])).toHaveLength(1);
  });
  it("decodes image_url object form", () => {
    const out = decodeContent([{ type: "image_url", image_url: { url: `data:image/png;base64,${PNG_B64}` } }]);
    expect(out[0]).toMatchObject({ type: "image", mimeType: "image/png" });
  });
  it("strips codex permissions blocks", () => {
    const t = "a<permissions instructions>secret</permissions instructions>b";
    expect(decodeContent(t)[0]).toEqual({ type: "text", text: "ab" });
  });
});

describe("decodeImagePart", () => {
  it("accepts anthropic source form", () => {
    const img = decodeImagePart({ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } });
    expect(img.mimeType).toBe("image/png");
  });
  it("rejects file_id", () => {
    expect(() => decodeImagePart({ type: "input_image", file_id: "f1" })).toThrow(/file_id/);
  });
  it("rejects http urls", () => {
    expect(() => decodeImagePart({ type: "image_url", image_url: { url: "https://x/y.png" } })).toThrow(/http/);
  });
});

describe("decodeDataImage", () => {
  it("parses data url and normalizes base64", () => {
    const img = decodeDataImage(`data:image/jpeg;base64,${JPEG_B64.slice(0, 20)}\n${JPEG_B64.slice(20)}`);
    expect(img.mimeType).toBe("image/jpeg");
    expect(img.data).toBe(JPEG_B64);
  });
  it("sniffs raw base64 mime", () => {
    const img = decodeDataImage(PNG_B64);
    expect(img.mimeType).toBe("image/png");
  });
  it("defaults mime to png for bare data: url", () => {
    const img = decodeDataImage(`data:,${PNG_B64}`);
    expect(img.mimeType).toBe("image/png");
  });
});

describe("sniffImageMIME", () => {
  it("detects png/jpeg/gif/webp", () => {
    expect(sniffImageMIME(PNG_B64)).toBe("image/png");
    expect(sniffImageMIME(JPEG_B64)).toBe("image/jpeg");
    expect(sniffImageMIME(btoa("GIF89a" + "x".repeat(10)))).toBe("image/gif");
    expect(sniffImageMIME(btoa("RIFFxxxxWEBP" + "x".repeat(4)))).toBe("image/webp");
    expect(sniffImageMIME(btoa("zzzzzzzz"))).toBe("");
  });
});

describe("rawOutputText", () => {
  it("returns strings directly and serializes objects", () => {
    expect(rawOutputText("ok")).toBe("ok");
    expect(rawOutputText({ a: 1 })).toBe('{"a":1}');
    expect(() => rawOutputText(undefined)).toThrow(DecodeError);
  });
});

describe("error types", () => {
  it("maps connect codes", () => {
    expect(openAIErrorType("unauthenticated: bad key")).toBe("authentication_error");
    expect(openAIErrorType("resource_exhausted: slow down")).toBe("rate_limit_error");
    expect(openAIErrorType("something else")).toBe("server_error");
    expect(anthropicErrorType("unavailable: down")).toBe("api_error");
    expect(anthropicErrorType("invalid_argument: nope")).toBe("invalid_request_error");
  });
});

describe("sanitizeText", () => {
  it("removes permissions instructions blocks incl multiline", () => {
    expect(sanitizeText("x\n<permissions instructions>\nabc\n</permissions instructions>\ny")).toBe("x\n\ny");
  });
});
