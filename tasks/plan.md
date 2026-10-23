# Build plan — devin-2api-worker

- [x] 0. Scaffold: package.json, deps, codegen (buf → src/gen), tsconfig, wrangler.toml, SPEC/plan.
- [ ] 1. `src/llm.ts` — core message/content/event model + validation (llm/request.go, llm/response.go).
- [ ] 2. `src/common.ts` — content/image decode, sanitize, error-type maps (api/common).
- [ ] 3. `src/devin.ts` — Connect envelope codec, request builder, response decoder, unary calls, adapter (adapter/devin + tool_definition).
- [ ] 4. `src/responses.ts` — OpenAI Responses request decode + JSON/SSE encode.
- [ ] 5. `src/chat.ts` — Chat Completions request decode + JSON/SSE encode.
- [ ] 6. `src/messages.ts` — Anthropic Messages request decode + JSON/SSE encode.
- [ ] 7. `src/index.ts` — worker entry: routes, auth, concurrency cap, error/status mapping, SSE pipeline, WebSocket endpoint.
- [ ] 8. `src/dashboard.ts` — /panel page+login+/panel/api/* (port template.go HTML + handler.go).
- [ ] 9. Integration suite (workerd): full flows per protocol, WS, dashboard, auth; `wrangler.toml`, README, deploy docs.

Status markers: `[ ]` pending, `[x]` done.
