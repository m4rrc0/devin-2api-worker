# devin-2api-worker

Cloudflare Workers port of [devin-2api](https://github.com/leookun/devin-2api): an unofficial OpenAI/Anthropic-compatible API proxy backed by Devin's Connect RPC upstream (`server.codeium.com`, `exa.api_server_pb.ApiServerService`).

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
| `MAX_BODY_BYTES` | `33554432` (32 MiB) | request body cap for `/v1/*` completions; lower on Workers Free to spare CPU |

Secrets (`wrangler secret put`):

| Secret | Purpose |
|---|---|
| `DEVIN_TOKEN` | **required** — Devin session token (`devin-session-token$...`) for upstream calls |
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

### Via GitHub Actions (automatic)

`.github/workflows/deploy.yml` runs tests + typecheck on every push to `main`, then deploys via `cloudflare/wrangler-action`. Required **repository secrets** (Settings → Secrets and variables → Actions):

| Secret | Purpose |
|---|---|
| `CLOUDFLARE_API_TOKEN` | API token with **Workers Scripts:Edit** on the account. Create at dash.cloudflare.com → My Profile → API Tokens → use the "Edit Cloudflare Workers" template. |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID — Cloudflare dashboard → Workers & Pages → right sidebar. |

CI deploys only the worker code and `[vars]` from `wrangler.toml` — it does **not** set app secrets. Set those once (see below).

### Getting a `DEVIN_TOKEN`

The token authenticates against Devin (`devin-session-token$...`). Two ways to extract it from a local Devin install — both are reverse-engineered paths and could move without notice; the CLI one is the more stable bet.

**Devin CLI (Linux/WSL, easiest)** — `devin auth login` writes TOML credentials:

```sh
devin auth login                    # https://docs.devin.ai/cli
cat ~/.local/share/devin/credentials.toml
# windsurf_api_key = "devin-session-token$..."
```

**Devin desktop app (SQLite state DB)**:

```sh
# macOS
sqlite3 ~/Library/"Application Support"/Devin/User/globalStorage/state.vscdb \
  "SELECT json_extract(value, '$.apiKey') FROM ItemTable WHERE key='windsurfAuthStatus';"

# Linux — Electron data dir is $XDG_CONFIG_HOME/Devin (default ~/.config/Devin;
# dir-name fallbacks: devin, Windsurf, windsurf)
sqlite3 ~/.config/Devin/User/globalStorage/state.vscdb \
  "SELECT json_extract(value, '$.apiKey') FROM ItemTable WHERE key='windsurfAuthStatus';"
```

Sources: [OpenTokenUsage Devin provider](https://github.com/PowerUserZ/OpenTokenUsage/blob/main/docs/providers/devin.md), [fast-context extract_key.py](https://github.com/ferstar/fast-context/blob/main/src/extract_key.py).

### Manually

```sh
wrangler secret put DEVIN_TOKEN
# optional: wrangler secret put API_KEY / DASHBOARD_PASSWORD
wrangler deploy
```

### Workers Free plan notes

- **CPU: 10 ms per invocation.** Waiting on the upstream `fetch` does not count, but body parsing and per-frame stream encode/decode do. Large image bodies and very long streams are the drivers — watch for `exceededCpu` (Error 1102) in metrics. `cpu_ms` is only configurable on Paid.
- **100,000 requests/day**; the dashboard panel counts too. Overage returns Cloudflare Error 1027.
- **6 simultaneous outgoing connections per invocation.** `/panel/api/status` fans out 5 — do not add more parallel upstream calls there.
- **Streaming/WS are fine**: no wall-clock limit while the client is connected; a WS upgrade counts as one request and frames are free.
- Full list: https://developers.cloudflare.com/workers/platform/limits/

## Layout

- `src/llm.ts` — intermediate content/message/event model
- `src/common.ts` — shared codecs (images, sanitization, error typing)
- `src/devin.ts` — upstream adapter: Connect wire (envelope codec, Basic auth), request build, stream decoder, model list
- `src/responses.ts`, `src/chat.ts`, `src/messages.ts` — the three protocol surfaces (request decode, JSON encode, SSE encoders)
- `src/index.ts` — routing, auth, concurrency, SSE/WS plumbing
- `src/dashboard.ts` — panel HTML + status/models APIs
- `src/gen/` — protobuf-es types generated from `proto/descriptors.binpb`
