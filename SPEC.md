# devin-2api-worker — Spec

Cloudflare Workers port of [devin-2api-go](https://github.com/m4rrc0/devin-2api-go): an LLM-API proxy that exposes Devin's Connect RPC chat upstream through OpenAI- and Anthropic-compatible endpoints.

## Goal

Byte-compatible upstream wire format (protobuf over Connect protocol, generated from the same `descriptors.binpb` the Go service uses), functional parity for every HTTP endpoint, deployable with `wrangler deploy`, secrets never in code.

## Endpoints (parity with Go service)

| Route | Behavior |
| --- | --- |
| `GET /healthz` | `{"status":"ok"}` (unauthenticated) |
| `GET /v1/models` | OpenAI model list via `GetCascadeModelConfigs`, 5-min in-memory TTL cache, includes configured model even if absent upstream |
| `GET /v1/models/{id}` | Single model or 404 |
| `POST /v1/responses` | OpenAI Responses API, JSON + typed SSE (`stream:true`) |
| `GET /v1/responses` (Upgrade: websocket) | Codex Responses WebSocket transport: first text frame is the request JSON; each SSE `data:` payload is returned as one text frame |
| `POST /v1/chat/completions` | OpenAI Chat Completions, JSON + `data:`-only SSE with `[DONE]` |
| `POST /v1/messages` | Anthropic Messages, JSON + typed SSE |
| `GET /panel` | Dashboard HTML (login page when `DASHBOARD_PASSWORD` set) |
| `POST /panel/login` | Password → `devin_panel_session` cookie (24h, HttpOnly) |
| `GET /panel/api/status` | Aggregated user/plan/capacity/status/providers/model-statuses |
| `GET /panel/api/models` | Cached model catalog with pricing dimensions |

## Upstream protocol

- `POST {DEVIN_BASE_URL}/exa.api_server_pb.ApiServerService/GetChatMessage` — `content-type: application/connect+proto`, `connect-protocol-version: 1`, `authorization: Basic {token}-{token}`. Body = Connect envelope (1-byte flags + 4-byte BE length + protobuf frame). Response = frame stream; terminal frame has flag `0x02` with JSON end-of-stream body (`error` may be set).
- Unary RPCs (`GetCascadeModelConfigs`, `CheckChatCapacity`, `GetStatus`, `GetModelProviders`, `GetModelStatuses`) — `content-type: application/proto`, raw binary body/response, same auth.
- `POST {DEVIN_BASE_URL}/exa.seat_management_pb.SeatManagementService/GetUserStatus` — `content-type: application/json`, `Connect-Protocol-Version: 1`, `Authorization: Bearer {token}` (dashboard only; mirrors the Go handler's JSON path).
- Request/response semantics (metadata fields, trajectory/cascade/execution UUIDs, tool definitions, current-turn image attachment, thinking/signature deltas, usage, stop-reason mapping) match `internal/adapter/devin` exactly.

## Semantics to preserve

- Intermediate model: user/assistant/toolResult messages; text/thinking/image/toolCall content; start/text/thinking/toolcall start/delta/end/done/error events.
- System prompt: `instructions`/`system`/`developer` messages merge; tool descriptions appended as `# tools descriptions` XML block; codex `<permissions instructions>` blocks stripped.
- Only current-turn (post-last-assistant) images go into `Images`; history images become `[Image omitted from history]`.
- Tool schemas stripped of `description`/`title`/`$comment`/`x-*` annotations except under `properties`.
- Vision check: images rejected early for known non-vision model UIDs.
- Usage: input/output/cacheRead/cacheWrite → per-protocol usage shapes.
- Stop reasons: `stop|length|toolUse|error` → OpenAI `stop|length|tool_calls|content_filter`, Responses `completed|incomplete`, Anthropic `end_turn|max_tokens|tool_use`.
- API key auth: `Authorization: Bearer` or `X-Api-Key`, SHA-256 + constant-time compare; empty key = open.
- Error mapping: `"<code>: <message>"` → HTTP status + OpenAI/Anthropic error types (verbatim upstream message passthrough).
- 32 MiB max request body. Unknown JSON fields ignored; unknown content parts skipped.

## Worker adaptation (deliberate deltas from Go)

- Config = env vars/secrets, not YAML: `DEVIN_TOKEN` (secret, required for /v1/*), `DEVIN_BASE_URL` (default `https://server.codeium.com`), `DEVIN_MODEL`, `API_KEY`, `DASHBOARD_PASSWORD`, `DEBUG`.
- No outbound proxy / force-http1 knobs (fetch owns transport).
- Concurrency limit kept as per-isolate in-memory (default 1024) — not a global guarantee on Workers.
- Debug logging: `DEBUG=true` emits structured JSON via `console.log` (Workers Logs) instead of files.
- Session/model caches are per-isolate.

## Stack

TypeScript, no framework router (URL switch), protobuf-es generated types in `src/gen` (buf codegen from `proto/descriptors.binpb`, types-filtered), wrangler 4, vitest + `@cloudflare/vitest-plugin` (workerd pool).

## Testing

- Unit tests per module porting the Go test coverage (request decoders, response encoders, decoder state machine, tool conversion, image decode, auth, error mapping, Connect envelope).
- Integration tests stubbing `fetch` at the adapter boundary: full request lifecycle for all 3 protocols, streaming + non-streaming, error propagation, models endpoint, dashboard APIs, WebSocket.
- Golden check: request builder output encodes/decodes through the generated schema.

## Security

- Secrets via `wrangler secret` only; never logged (token excluded from debug projections).
- API key compared via SHA-256 + constant-time compare.
- Panel password compared constant-time; session IDs 256-bit random; HttpOnly cookie.
- No request-body size blowups (32 MiB cap), upstream errors sanitized of transport internals.

## CI/CD

GitHub Actions deploys the worker on every push to `main`:

- `.github/workflows/deploy.yml` runs install → tests → typecheck → `wrangler deploy` via `cloudflare/wrangler-action`.
- Required repo secrets: `CLOUDFLARE_API_TOKEN` (Workers Scripts Edit on this account), `CLOUDFLARE_ACCOUNT_ID`.
- App secrets (DEVIN_TOKEN etc.) are NOT set by CI — set once via `wrangler secret put` or the dashboard.
