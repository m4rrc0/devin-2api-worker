// Admin panel — port of internal/dashboard/handler.go (+ functional template equivalent).
import { create, toBinary } from "@bufbuild/protobuf";
import {
  CheckChatCapacityRequestSchema,
  CheckChatCapacityResponseSchema,
  GetCascadeModelConfigsRequestSchema,
  GetCascadeModelConfigsResponseSchema,
  GetModelProvidersRequestSchema,
  GetModelProvidersResponseSchema,
  GetModelStatusesRequestSchema,
  GetModelStatusesResponseSchema,
  GetStatusRequestSchema,
  GetStatusResponseSchema,
} from "./gen/exa/api_server_pb/api_server_pb.js";
import { MetadataSchema } from "./gen/exa/codeium_common_pb/codeium_common_pb.js";
import { DevinAdapter, randomHex } from "./devin.js";
import type { Env } from "./index.js";

const DASH_CLIENT_NAME = "windsurf";
const DASH_CLIENT_VERSION = "1.48.2";
const SEAT_USER_STATUS_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";
const SESSION_COOKIE = "devin_panel_session";
const SESSION_TTL_MS = 24 * 3600 * 1000;
const CACHE_TTL_MS = 5 * 60 * 1000;

type Json = Record<string, unknown>;

// Per-isolate state.
const sessionTokens = new Map<string, number>();
let modelsCache: { data: Json[]; expiry: number } | undefined;
let providersCache: { data: Json[]; expiry: number } | undefined;
let modelStatusesCache: { data: Json[]; expiry: number } | undefined;

let dashAdapter: DevinAdapter | undefined;
let dashAdapterKey = "";

function adapterFor(env: Env): DevinAdapter | undefined {
  const token = env.DEVIN_TOKEN?.trim() ?? "";
  if (token === "") return undefined;
  const baseURL = env.DEVIN_BASE_URL?.trim() || "https://server.codeium.com";
  const key = `${baseURL} ${token}`;
  if (!dashAdapter || dashAdapterKey !== key) {
    dashAdapter = new DevinAdapter({ baseUrl: baseURL, token, model: "" });
    dashAdapterKey = key;
  }
  return dashAdapter;
}

function baseURL(env: Env): string {
  return (env.DEVIN_BASE_URL?.trim() || "https://server.codeium.com").replace(/\/+$/, "");
}

function metadataBody(token: string) {
  return create(MetadataSchema, {
    apiKey: token,
    extensionName: DASH_CLIENT_NAME,
    extensionVersion: DASH_CLIENT_VERSION,
    ideName: DASH_CLIENT_NAME,
    ideVersion: DASH_CLIENT_VERSION,
    locale: "en",
    os: "win",
    f: randomHex(32),
  });
}

function isAuthenticated(request: Request, env: Env): boolean {
  const password = env.DASHBOARD_PASSWORD?.trim() ?? "";
  if (password === "") return true;
  const header = request.headers.get("Cookie") ?? "";
  const match = /(?:^|;\s*)devin_panel_session=([^;]+)/.exec(header);
  if (!match) return false;
  const expiry = sessionTokens.get(match[1] ?? "");
  if (expiry === undefined) return false;
  if (Date.now() > expiry) {
    sessionTokens.delete(match[1] ?? "");
    return false;
  }
  return true;
}

function generateSessionID(): string {
  return randomHex(16);
}

function strAny(...vals: unknown[]): string {
  for (const v of vals) {
    if (typeof v === "string" && v !== "") return v;
    if (typeof v === "number") return String(v);
  }
  return "";
}

function boolAny(...vals: unknown[]): boolean {
  for (const v of vals) {
    if (typeof v === "boolean") return v;
  }
  return false;
}

function numAny(...vals: unknown[]): unknown {
  for (const v of vals) {
    if (typeof v === "number") return v;
    if (typeof v === "string" && v !== "" && !Number.isNaN(Number(v))) return Number(v);
  }
  return null;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

async function fetchUserStatus(env: Env): Promise<{ user?: Json; plan?: Json; planInfo?: Json }> {
  const token = env.DEVIN_TOKEN?.trim() ?? "";
  const body = JSON.stringify({
    metadata: {
      api_key: token,
      extension_name: DASH_CLIENT_NAME,
      extension_version: DASH_CLIENT_VERSION,
      ide_name: DASH_CLIENT_NAME,
      ide_version: DASH_CLIENT_VERSION,
      locale: "en",
      os: "windows",
    },
  });
  const resp = await fetch(`${baseURL(env)}${SEAT_USER_STATUS_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
      Authorization: `Bearer ${token}`,
    },
    body,
  });
  const raw = await resp.text();
  if (resp.status !== 200) {
    throw new Error(`GetUserStatus HTTP ${resp.status}: ${truncate(raw, 300)}`);
  }
  let root: Json;
  try {
    root = JSON.parse(raw);
  } catch (e) {
    throw new Error(`decode GetUserStatus: ${(e as Error).message}`);
  }
  const us = (root.userStatus ?? root.user_status) as Json | undefined;
  if (!us || typeof us !== "object") throw new Error("GetUserStatus: empty userStatus");

  const user: Json = {
    name: strAny(us.name),
    email: strAny(us.email),
    pro: boolAny(us.pro),
    user_id: strAny(us.userId, us.user_id),
    team_id: strAny(us.teamId, us.team_id),
    teams_tier: strAny(us.teamsTier, us.teams_tier).replace(/^TEAMS_TIER_/, ""),
    used_prompt_credits: numAny(us.userUsedPromptCredits, us.user_used_prompt_credits),
    used_flow_credits: numAny(us.userUsedFlowCredits, us.user_used_flow_credits),
    max_premium_chat: numAny(us.maxNumPremiumChatMessages, us.max_num_premium_chat_messages),
  };

  let plan: Json | undefined;
  let planInfo: Json | undefined;
  const ps = (us.planStatus ?? us.plan_status) as Json | undefined;
  if (ps) {
    plan = {
      available_prompt_credits: numAny(ps.availablePromptCredits, ps.available_prompt_credits),
      available_flow_credits: numAny(ps.availableFlowCredits, ps.available_flow_credits),
      available_flex_credits: numAny(ps.availableFlexCredits, ps.available_flex_credits),
      used_flex_credits: numAny(ps.usedFlexCredits, ps.used_flex_credits),
      used_flow_credits: numAny(ps.usedFlowCredits, ps.used_flow_credits),
      used_prompt_credits: numAny(ps.usedPromptCredits, ps.used_prompt_credits),
      daily_quota_remaining: numAny(ps.dailyQuotaRemainingPercent, ps.daily_quota_remaining_percent),
      weekly_quota_remaining: numAny(ps.weeklyQuotaRemainingPercent, ps.weekly_quota_remaining_percent),
      daily_quota_reset: numAny(ps.dailyQuotaResetAtUnix, ps.daily_quota_reset_at_unix),
      weekly_quota_reset: numAny(ps.weeklyQuotaResetAtUnix, ps.weekly_quota_reset_at_unix),
      acu_consumed: numAny(ps.acuConsumed, ps.acu_consumed),
      acu_limit: numAny(ps.acuLimit, ps.acu_limit),
      overage_balance_micros: numAny(ps.overageBalanceMicros, ps.overage_balance_micros),
      plan_start: strAny(ps.planStart, ps.plan_start),
      plan_end: strAny(ps.planEnd, ps.plan_end),
    };
    const pi = (ps.planInfo ?? ps.plan_info) as Json | undefined;
    if (pi) {
      plan.plan_name = strAny(pi.planName, pi.plan_name);
      plan.monthly_prompt_credits = numAny(pi.monthlyPromptCredits, pi.monthly_prompt_credits);
      plan.monthly_flow_credits = numAny(pi.monthlyFlowCredits, pi.monthly_flow_credits);
      plan.billing_strategy = strAny(pi.billingStrategy, pi.billing_strategy).replace(/^BILLING_STRATEGY_/, "");
      plan.is_teams = boolAny(pi.isTeams, pi.is_teams);
      plan.is_enterprise = boolAny(pi.isEnterprise, pi.is_enterprise);
      plan.can_buy_more = boolAny(pi.canBuyMoreCredits, pi.can_buy_more_credits);
      plan.has_paid_features = boolAny(pi.hasPaidFeatures, pi.has_paid_features);
    }
  }

  const top = root.planInfo as Json | undefined;
  if (top) {
    planInfo = {
      plan_name: strAny(top.planName, top.plan_name),
      monthly_prompt_credits: numAny(top.monthlyPromptCredits, top.monthly_prompt_credits),
      monthly_flow_credits: numAny(top.monthlyFlowCredits, top.monthly_flow_credits),
      billing_strategy: strAny(top.billingStrategy, top.billing_strategy).replace(/^BILLING_STRATEGY_/, ""),
      is_teams: boolAny(top.isTeams, top.is_teams),
      is_enterprise: boolAny(top.isEnterprise, top.is_enterprise),
      has_paid_features: boolAny(top.hasPaidFeatures, top.has_paid_features),
      max_premium_chat_messages: numAny(top.maxNumPremiumChatMessages, top.max_num_premium_chat_messages),
    };
  } else if (plan?.plan_name) {
    planInfo = {
      plan_name: plan.plan_name,
      monthly_prompt_credits: plan.monthly_prompt_credits,
      monthly_flow_credits: plan.monthly_flow_credits,
      billing_strategy: plan.billing_strategy,
      is_teams: plan.is_teams,
      is_enterprise: plan.is_enterprise,
      has_paid_features: plan.has_paid_features,
    };
  }
  return { user, plan, planInfo };
}

function shortEnumName(value: number, enumObj: Record<number, string>, prefix: string): string {
  const name = enumObj[value];
  if (typeof name !== "string") return String(value);
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

async function cachedModels(env: Env): Promise<Json[]> {
  if (modelsCache && Date.now() < modelsCache.expiry) return modelsCache.data;
  const adapter = adapterFor(env);
  if (!adapter) throw new Error("provider adapter is not configured");
  const token = env.DEVIN_TOKEN?.trim() ?? "";
  const body = toBinary(
    GetCascadeModelConfigsRequestSchema,
    create(GetCascadeModelConfigsRequestSchema, { metadata: metadataBody(token) }),
  );
  const resp = await adapter.unary("GetCascadeModelConfigs", GetCascadeModelConfigsResponseSchema, body);

  const { ModelProvider, APIProvider, ModelPricingType, ModelCostTier, ModelDimensionKind } =
    await import("./gen/exa/codeium_common_pb/codeium_common_pb.js");

  const models: Json[] = [];
  for (const c of resp.clientModelConfigs) {
    let uid = c.modelUid;
    if (uid === "" && c.modelOrAlias && c.modelOrAlias.choice.case === "modelUid") {
      uid = c.modelOrAlias.choice.value;
    }
    const costTierNum = c.modelCostTier;
    const costTier =
      costTierNum === ModelCostTier.FREE
        ? "free"
        : costTierNum === ModelCostTier.LOW
          ? "low"
          : costTierNum === ModelCostTier.MEDIUM
            ? "medium"
            : costTierNum === ModelCostTier.HIGH
              ? "high"
              : "unspecified";
    const mult = c.creditMultiplier;
    const m: Json = {
      uid,
      label: c.label,
      description: c.description,
      cost_tier: costTier,
      credit_multiplier: mult,
      multiplier_known: mult !== 0 || costTier === "free",
      pricing_type: shortEnumName(c.pricingType, ModelPricingType as unknown as Record<number, string>, "MODEL_PRICING_TYPE_"),
      provider: shortEnumName(c.provider, ModelProvider as unknown as Record<number, string>, "MODEL_PROVIDER_"),
      api_provider: shortEnumName(c.apiProvider, APIProvider as unknown as Record<number, string>, "API_PROVIDER_"),
      max_tokens: c.maxTokens,
      disabled: c.disabled,
      is_premium: c.isPremium,
      is_beta: c.isBeta,
      is_new: c.isNew,
      is_recommended: c.isRecommended,
      supports_images: c.supportsImages,
      is_capacity_limited: c.isCapacityLimited,
      supports_legacy: c.supportsLegacy,
    };
    const dims: Json[] = [];
    let inputPrice = 0, cachedPrice = 0, outputPrice = 0;
    let hasInput = false, hasCached = false, hasOutput = false;
    for (const d of c.modelDimensions) {
      dims.push({
        label: d.label,
        value: d.value,
        min: d.minRange,
        max: d.maxRange,
        denominator: d.denominator,
        kind: shortEnumName(d.kind, ModelDimensionKind as unknown as Record<number, string>, "MODEL_DIMENSION_KIND_"),
        info: d.info,
      });
      switch (d.label.toLowerCase()) {
        case "input":
          inputPrice = d.value; hasInput = true; break;
        case "cached input":
        case "cached_input":
        case "cache read":
        case "cache_read":
          cachedPrice = d.value; hasCached = true; break;
        case "output":
          outputPrice = d.value; hasOutput = true; break;
      }
    }
    if (dims.length > 0) m.dimensions = dims;
    if (hasInput) m.price_input = inputPrice;
    if (hasCached) m.price_cached = cachedPrice;
    if (hasOutput) m.price_output = outputPrice;
    if (c.promoStatus?.isActive) {
      const promo: Json = { active: true, label: c.promoStatus.label };
      const ed = c.promoStatus.endDate;
      if (ed && Number(ed.seconds) !== 0) {
        promo.end_date = new Date(Number(ed.seconds) * 1000 + ed.nanos / 1e6).toISOString();
      }
      m.promo = promo;
    }
    if (c.fastStatus?.isActive) {
      m.fast = { active: true, tooltip: c.fastStatus.tooltip };
    }
    if (c.modelFamilyMetadata) {
      m.family = c.modelFamilyMetadata.modelFamilyLabel;
      m.is_default_in_family = c.modelFamilyMetadata.isDefaultModelInFamily || c.isDefaultModelInFamily;
    }
    if (c.disabledReason) {
      m.disabled_reason = c.disabledReason.shortReason;
      m.disabled_description = c.disabledReason.description;
    }
    if (c.betaWarningMessage !== "") m.beta_warning = c.betaWarningMessage;
    models.push(m);
  }
  modelsCache = { data: models, expiry: Date.now() + CACHE_TTL_MS };
  return models;
}

async function cachedProviders(env: Env): Promise<Json[] | undefined> {
  if (providersCache && Date.now() < providersCache.expiry) return providersCache.data;
  const adapter = adapterFor(env);
  if (!adapter) return undefined;
  const { ModelProvider } = await import("./gen/exa/codeium_common_pb/codeium_common_pb.js");
  const body = toBinary(GetModelProvidersRequestSchema, create(GetModelProvidersRequestSchema, {}));
  try {
    const resp = await adapter.unary("GetModelProviders", GetModelProvidersResponseSchema, body);
    const providers = resp.modelProviders.map((p) => ({
      provider: shortEnumName(p.provider, ModelProvider as unknown as Record<number, string>, "MODEL_PROVIDER_"),
      display_name: p.displayName,
    }));
    providersCache = { data: providers, expiry: Date.now() + CACHE_TTL_MS };
    return providers;
  } catch {
    return undefined;
  }
}

async function cachedModelStatuses(env: Env): Promise<Json[] | undefined> {
  if (modelStatusesCache && Date.now() < modelStatusesCache.expiry) return modelStatusesCache.data;
  const adapter = adapterFor(env);
  if (!adapter) return undefined;
  const token = env.DEVIN_TOKEN?.trim() ?? "";
  const { Model, ModelStatus } = await import("./gen/exa/codeium_common_pb/codeium_common_pb.js");
  const body = toBinary(
    GetModelStatusesRequestSchema,
    create(GetModelStatusesRequestSchema, { metadata: metadataBody(token) }),
  );
  try {
    const resp = await adapter.unary("GetModelStatuses", GetModelStatusesResponseSchema, body);
    const statuses = resp.modelStatusInfos.map((s) => ({
      model: s.modelUid !== "" ? s.modelUid : shortEnumName(s.model, Model as unknown as Record<number, string>, "MODEL_"),
      status: shortEnumName(s.status, ModelStatus as unknown as Record<number, string>, "MODEL_STATUS_"),
      message: s.message,
    }));
    modelStatusesCache = { data: statuses, expiry: Date.now() + CACHE_TTL_MS };
    return statuses;
  } catch {
    return undefined;
  }
}

async function apiStatus(env: Env): Promise<Response> {
  const result: Json = {};
  try {
    const { user, plan, planInfo } = await fetchUserStatus(env);
    if (user) result.user = user;
    if (plan) result.plan_status = plan;
    if (planInfo) result.plan_info = planInfo;
  } catch (e) {
    result.user_status_error = (e as Error).message;
  }

  const adapter = adapterFor(env);
  const token = env.DEVIN_TOKEN?.trim() ?? "";
  const { StatusLevel } = await import("./gen/exa/codeium_common_pb/codeium_common_pb.js");
  const tasks: Promise<void>[] = [];

  if (adapter) {
    tasks.push(
      adapter
        .unary(
          "CheckChatCapacity",
          CheckChatCapacityResponseSchema,
          toBinary(CheckChatCapacityRequestSchema, create(CheckChatCapacityRequestSchema, { metadata: metadataBody(token) })),
        )
        .then((resp) => {
          result.capacity = {
            has_capacity: resp.hasCapacity,
            message: resp.message,
            active_sessions: resp.activeSessions,
          };
        })
        .catch((e) => {
          result.capacity_error = (e as Error).message;
        }),
      adapter
        .unary(
          "GetStatus",
          GetStatusResponseSchema,
          toBinary(GetStatusRequestSchema, create(GetStatusRequestSchema, { metadata: metadataBody(token) })),
        )
        .then((resp) => {
          result.ide_status = {
            level: shortEnumName(resp.status?.level ?? 0, StatusLevel as unknown as Record<number, string>, "STATUS_LEVEL_"),
            message: resp.status?.message ?? "",
          };
          result.show_review_prompt = resp.showReviewPrompt;
        })
        .catch((e) => {
          result.status_error = (e as Error).message;
        }),
      cachedModelStatuses(env).then((s) => {
        if (s) result.model_statuses = s;
      }),
      cachedProviders(env).then((p) => {
        if (p) result.providers = p;
      }),
    );
  }
  await Promise.all(tasks);
  return Response.json(result);
}

async function apiModels(env: Env): Promise<Response> {
  try {
    const models = await cachedModels(env);
    return Response.json({ models });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}

// ---- HTML pages ----

const LOGIN_PAGE = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Devin API - 管理面板</title>
<style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}.login-box{background:#1e293b;padding:32px;border-radius:12px;width:320px;box-shadow:0 4px 24px #0008}h1{font-size:20px;margin:0 0 20px;text-align:center}input{width:100%;padding:10px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;box-sizing:border-box}button{width:100%;margin-top:12px;padding:10px;border:none;border-radius:8px;background:#6366f1;color:#fff;font-size:15px;cursor:pointer}.error{color:#f87171;text-align:center;margin-top:10px;display:none}</style></head>
<body><div class="login-box"><h1>Devin API 管理面板</h1>
<form id="loginForm"><input id="password" type="password" placeholder="访问密码" autocomplete="current-password"><button type="submit">登录</button></form>
<div class="error" id="err">密码错误</div></div>
<script>
document.getElementById('loginForm').addEventListener('submit',async e=>{e.preventDefault();
const pwd=document.getElementById('password').value;
const res=await fetch('/panel/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'password='+encodeURIComponent(pwd)});
if(res.ok){location.reload()}else{const el=document.getElementById('err');el.style.display='block';setTimeout(()=>el.style.display='none',2000)}});
</script></body></html>`;

const PANEL_PAGE = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Devin API - 管理面板</title>
<style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:24px}.container{max-width:1200px;margin:0 auto}h1{font-size:22px}.section{background:#1e293b;border-radius:12px;padding:20px;margin:16px 0}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px}.card{background:#0f172a;border-radius:8px;padding:12px}.label{font-size:12px;color:#94a3b8}.value{font-size:16px;font-weight:600;margin-top:4px}.loading{color:#94a3b8}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:8px;text-align:left;border-bottom:1px solid #334155}th{color:#94a3b8;font-weight:500;position:sticky;top:0;background:#1e293b}.mono{font-family:ui-monospace,monospace;font-size:12px}.muted{color:#64748b}.model-scroll{max-height:480px;overflow:auto}.filters{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}.filters input,.filters select{background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:8px 10px;border-radius:8px;font-size:13px}.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;margin:1px;background:#334155}.note{font-size:12px;color:#64748b;margin-top:12px}.err{color:#f87171;font-size:13px;margin-top:8px}</style></head>
<body><div class="container"><h1>Devin API 管理面板</h1>
<div class="section" id="statusSection"><div class="loading">加载中...</div></div>
<div class="section"><h2 style="margin-top:0">模型目录</h2>
<div class="filters"><input id="search" placeholder="搜索 uid / 名称" oninput="render()"><select id="fProvider" onchange="render()"><option value="">全部 Provider</option></select><select id="fTier" onchange="render()"><option value="">全部 Tier</option><option value="free">free</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="unspecified">unspecified</option></select></div>
<div class="stats muted mono" id="stats">加载中...</div>
<div class="model-scroll"><table id="modelTable"><thead><tr><th>模型</th><th>Provider / API</th><th>Tier</th><th>价格 in/out</th><th>Max tokens</th><th>标记</th></tr></thead><tbody></tbody></table></div></div>
<div class="note">Worker port of devin-2api panel. 数据来自上游 Connect RPC。</div></div>
<script>
let allModels=[];
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const card=(l,v)=>'<div class="card"><div class="label">'+esc(l)+'</div><div class="value">'+esc(String(v))+'</div></div>';
async function loadStatus(){
 const el=document.getElementById('statusSection');
 try{const res=await fetch('/panel/api/status');const data=await res.json();let html='<h2 style="margin-top:0">账户与状态</h2><div class="grid">';
 const u=data.user||{},p=data.plan_status||{},pi=data.plan_info||{};
 if(data.user){html+=card('用户',u.name||'-')+card('邮箱',u.email||'-')+card('Pro',u.pro?'是':'否')+card('Tier',u.teams_tier||'-');}
 if(pi.plan_name){html+=card('套餐',pi.plan_name)+card('月 Prompt 配额',pi.monthly_prompt_credits??'-')+card('计费策略',pi.billing_strategy||'-');}
 if(data.plan_status){html+=card('剩余 Prompt credits',p.available_prompt_credits??'-')+card('剩余 Flow credits',p.available_flow_credits??'-')+card('日配额剩余',(p.daily_quota_remaining??'-')+'%')+card('周配额剩余',(p.weekly_quota_remaining??'-')+'%');}
 if(data.capacity){const c=data.capacity;html+=card('容量',c.has_capacity?'可用':'受限')+card('活跃会话',c.active_sessions??'-');if(c.message)html+=card('容量信息',c.message);}
 if(data.ide_status){html+=card('IDE 状态',data.ide_status.level||'-');}
 html+='</div>';
 if(data.providers){html+='<h2 style="margin-top:16px">渠道</h2><div class="grid">'+data.providers.map(x=>card(x.display_name||x.provider,x.provider)).join('')+'</div>';}
 if(data.model_statuses){html+='<h2 style="margin-top:16px">模型状态告警</h2><div class="grid">'+data.model_statuses.filter(s=>s.status&&s.status!=='HEALTHY'&&s.status!=='OK'&&s.status!=='AVAILABLE').map(s=>card(s.model,s.status)).join('')+'</div>';}
 if(data.user_status_error)html+='<div class="err">账户用量拉取失败: '+esc(data.user_status_error)+'</div>';
 if(data.capacity_error)html+='<div class="err">'+esc(data.capacity_error)+'</div>';
 if(data.status_error)html+='<div class="err">'+esc(data.status_error)+'</div>';
 el.innerHTML=html;}catch(e){el.innerHTML='<div class="err">'+esc(e.message)+'</div>';}
}
async function loadModels(){
 try{const res=await fetch('/panel/api/models');const data=await res.json();allModels=data.models||[];
 const provs=[...new Set(allModels.map(m=>m.provider).filter(Boolean))].sort();
 const sel=document.getElementById('fProvider');provs.forEach(p=>{const o=document.createElement('option');o.value=p;o.textContent=p;sel.appendChild(o)});
 render();}catch(e){document.getElementById('stats').textContent='加载失败: '+e.message;}
}
function render(){
 const q=document.getElementById('search').value.trim().toLowerCase();
 const prov=document.getElementById('fProvider').value,tier=document.getElementById('fTier').value;
 const models=allModels.filter(m=>(!q||(m.uid+' '+(m.label||'')).toLowerCase().includes(q))&&(!prov||m.provider===prov)&&(!tier||m.cost_tier===tier));
 document.getElementById('stats').textContent='显示 '+models.length+' / 共 '+allModels.length+' 个模型';
 const tbody=document.querySelector('#modelTable tbody');
 if(!models.length){tbody.innerHTML='<tr><td colspan="6" class="loading">无匹配模型</td></tr>';return;}
 tbody.innerHTML=models.map(m=>{
  let badges='';const add=(t,c)=>{badges+='<span class="badge">'+esc(t)+'</span>'};
  if(m.disabled)add('disabled');if(m.is_premium)add('premium');if(m.is_beta)add('beta');if(m.is_new)add('new');if(m.is_recommended)add('推荐');if(m.supports_images)add('图片');if(m.is_capacity_limited)add('限容');if(m.promo)add('promo');if(m.fast)add('fast');
  const pin=m.price_input??m.credit_multiplier??'-',pout=m.price_output??'-';
  return '<tr><td><strong>'+esc(m.label||'-')+'</strong><div class="mono muted">'+esc(m.uid)+'</div></td><td>'+esc(m.provider||'-')+'<div class="mono muted">'+esc(m.api_provider||'')+'</div></td><td>'+esc(m.cost_tier||'-')+'</td><td class="mono">'+esc(String(pin))+' / '+esc(String(pout))+'</td><td class="mono">'+esc(String(m.max_tokens||'-'))+'</td><td>'+badges+'</td></tr>';
 }).join('');
}
loadStatus();loadModels();
</script></body></html>`;

export async function dashboard(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  const password = env.DASHBOARD_PASSWORD?.trim() ?? "";

  if (method === "GET" && path === "/panel") {
    if (password !== "" && !isAuthenticated(request, env)) {
      return new Response(LOGIN_PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return new Response(PANEL_PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  if (method === "POST" && path === "/panel/login") {
    if (password === "") {
      return Response.json({ ok: true, open: true });
    }
    const form = await request.formData();
    const provided = typeof form.get("password") === "string" ? (form.get("password") as string) : "";
    if (provided !== password) {
      return new Response('{"error":"密码错误"}', { status: 401, headers: { "Content-Type": "application/json" } });
    }
    const sessionID = generateSessionID();
    sessionTokens.set(sessionID, Date.now() + SESSION_TTL_MS);
    const cookie = `${SESSION_COOKIE}=${sessionID}; Path=/; HttpOnly; Max-Age=86400; SameSite=Lax`;
    return new Response('{"ok":true}', {
      headers: { "Content-Type": "application/json", "Set-Cookie": cookie },
    });
  }

  if (method === "GET" && path === "/panel/api/status") {
    if (!isAuthenticated(request, env)) {
      return new Response('{"error":"未授权"}', { status: 401 });
    }
    return apiStatus(env);
  }

  if (method === "GET" && path === "/panel/api/models") {
    if (!isAuthenticated(request, env)) {
      return new Response('{"error":"未授权"}', { status: 401 });
    }
    return apiModels(env);
  }

  return new Response("Not Found", { status: 404 });
}
