# devin-2api-worker

Cloudflare Workers port of [devin-2api-go](https://github.com/m4rrc0/devin-2api-go): an OpenAI/Anthropic-compatible API proxy backed by Devin's Connect RPC upstream (`server.codeium.com`, `exa.api_server_pb.ApiServerService`).

## Endpoints

| Route | Protocol |
|---|---|
| `GET /healthz` | health check |
| `GET /v1/models`, `GET /v1/models/{id}` | OpenAI model list |
| `POST /v1/responses` | OpenAI Responses API (SSE or JSON) |
| `GET /v1/responses` (WS upgrade) | OpenAI Responses WebSocket (`responses_websockets=2026-02-06`) |
| `POST /v1/chat/completions` | OpenAI Chat Completions (SSE or JSON) |
| `POST /v1/messages` | Anthropic Messages (SSE or JSON) |
| `GET /panel` | admin dashboard (status, quota, model catalog) |

## Configuration

Set in `wrangler.toml` `[vars]` or the dashboard:

| Var | Default | Purpose |
|---|---|---|
| `DEVIN_BASE_URL` | `https://server.codeium.com` | upstream base URL |
| `DEVIN_MODEL` | `""` | fallback model when request omits one |
| `DEBUG` | `false` | console debug logging |
| `MAX_CONCURRENCY` | `1024` | per-isolate concurrent request cap |

Secrets (`wrangler secret put`):

| Secret | Purpose |
|---|---|
| `DEVIN_TOKEN` | **required** — Devin API token for upstream calls |
| `API_KEY` | optional — protects `/v1/*`; accepted as `Authorization: Bearer` or `X-Api-Key` |
| `DASHBOARD_PASSWORD` | optional — password-gates `/panel` (session cookie, 24h) |

## Develop

```sh
npm i --legacy-peer-deps   # required: peer-dep resolution
npm test                   # vitest (workerd pool)
npm run typecheck          # tsc --noEmit
npm run dev                # wrangler dev
npm run build              # wrangler deploy --dry-run (bundle check)
npm run gen                # regenerate proto types from proto/descriptors.binpb
```

## Deploy

```sh
wrangler secret put DEVIN_TOKEN
wrangler deploy
```

## Layout

- `src/llm.ts` — intermediate content/message/event model
- `src/common.ts` — shared codecs (images, sanitization, error typing)
- `src/devin.ts` — upstream adapter: Connect wire (envelope codec, Basic auth), request build, stream decoder, model list
- `src/responses.ts`, `src/chat.ts`, `src/messages.ts` — the three protocol surfaces (request decode, JSON encode, SSE encoders)
- `src/index.ts` — routing, auth, concurrency, SSE/WS plumbing
- `src/dashboard.ts` — panel HTML + status/models APIs
- `src/gen/` — protobuf-es types generated from `proto/descriptors.binpb`
