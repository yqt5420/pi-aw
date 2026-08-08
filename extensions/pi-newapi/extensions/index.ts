/**
 * pi-newapi — auto-discover models, pricing, and reasoning compatibility for
 * any OpenAI-compatible NewAPI / one-api gateway.
 *
 * Gateway base URL and API key are configurable (no hardcoded site), so the
 * same package works for anyone:
 *   - Set `NEWAPI_BASE_URL` (e.g. https://your-gateway.example/v1) and
 *     `NEWAPI_API_KEY` in the environment, OR
 *   - Run `/login newapi` once and paste the key interactively.
 *
 * The extension is an async factory: at startup it fetches the gateway's
 * `/api/pricing` endpoint (NewAPI's public pricing/catalog API — no key
 * required for listing) and registers every available model with resolved
 * $/M-token pricing, detected reasoning behavior, and per-vendor thinking
 * compatibility. Models then appear in `/model` and `--list-models` just like
 * built-in providers. If the network fetch fails, it falls back to the last
 * cached model list in `~/.pi/agent/newapi-models-cache.json`.
 *
 * Context windows / max output / reasoning flags / thinking levels all come
 * from pi's bundled built-in model catalog (see builtin.ts) — the same
 * curated source pi uses for its own providers. The gateway's /api/pricing
 * exposes no such metadata at all. builtin.ts normalizes gateway ids (strips
 * `pool-` prefixes and dated/version codes like -0731) to hit the canonical
 * model, so thinking levels show accurately. Anything pi's catalog doesn't
 * know falls back to per-vendor heuristics (vendor-detect.ts).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api } from "@earendil-works/pi-ai";

import { detectVendor, vendorDefaults } from "./vendor-detect.ts";
import { resolveCost, pickGroupRatio } from "./pricing.ts";
import type { NewApiPricingResponse, NewApiPricingEntry } from "./pricing.ts";
import { lookupBuiltin, type BuiltinMeta } from "./builtin.ts";
import { join } from "node:path";
import { homedir } from "node:os";

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";

const PROVIDER_ID = "newapi";

/** Resolve the pi agent config directory, honoring PI_CODING_AGENT_DIR override. */
function agentDir(): string {
  if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;
  return join(homedir(), ".pi", "agent");
}

const CACHE_PATH = join(agentDir(), "newapi-models-cache.json");
const CONFIG_PATH = join(agentDir(), "newapi-config.json");
/** 自动维护的 pi 模型清单（见 writeModelsJson / WriteModelsSchema）。 */
const MODELS_JSON_PATH = join(agentDir(), "models.json");

interface NewApiConfig {
  /** Gateway base URL, e.g. https://your-gateway.example/v1 */
  baseUrl?: string;
  /** API key (sk-...). Stored in plaintext on disk — same trust level as env. */
  apiKey?: string;
}

let _cfgLoaded = false;
let _cfg: NewApiConfig | undefined;

/** Read the user config file once per load (cached). Malformed file is ignored. */
function readConfigFile(): NewApiConfig | undefined {
  if (_cfgLoaded) return _cfg;
  _cfgLoaded = true;
  try {
    if (existsSync(CONFIG_PATH)) {
      _cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as NewApiConfig;
    }
  } catch {
    /* malformed config — ignore */
  }
  return _cfg;
}

/** Write the config file (merges with existing fields) and refresh the in-memory cache. */
function writeConfigFile(patch: NewApiConfig): void {
  mkdirSync(agentDir(), { recursive: true });
  const merged = { ...(readConfigFile() ?? {}), ...patch };
  // 原子写：tmp + rename，避免进程中断留下半截 JSON
  const tmpPath = `${CONFIG_PATH}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, CONFIG_PATH);
  _cfg = merged;
  _cfgLoaded = true;
}

/**
 * Normalize a user-entered gateway URL into the canonical `https://host/v1`
 * form used by OpenAI-compatible APIs. Accepts:
 *   - https://api.example.com
 *   - https://api.example.com/
 *   - https://api.example.com/v1
 *   - https://api.example.com/v1/
 * Trims, strips trailing slashes, and appends `/v1` if no `/vN` suffix is
 * present. Raises on obviously invalid input (empty / no scheme).
 */
function normalizeBaseUrl(input: string): { url: string; appended: boolean } | { error: string } {
  const raw = input.trim();
  if (!raw) return { error: "地址为空" };
  if (!/^https?:\/\//i.test(raw)) return { error: "地址必须以 http:// 或 https:// 开头" };
  // Strip all trailing slashes.
  let url = raw.replace(/\/+$/, "");
  // If the last path segment is not a version like /v1, /v2, append /v1.
  const appended = !/\/v\d+$/i.test(url);
  if (appended) url += "/v1";
  return { url, appended };
}

/** Resolve base URL: config file > env var. */
function resolveBaseUrl(): string | undefined {
  const fromFile = readConfigFile()?.baseUrl?.trim().replace(/\/+$/, "");
  if (fromFile) return fromFile;
  return process.env.NEWAPI_BASE_URL?.trim().replace(/\/+$/, "") || undefined;
}

/** Resolve API key: config file > env var. */
function resolveApiKey(): string | undefined {
  const fromFile = readConfigFile()?.apiKey?.trim();
  if (fromFile) return fromFile;
  return process.env.NEWAPI_API_KEY?.trim() || undefined;
}

/**
 * The pricing endpoint is `/api/pricing` on the gateway *root*, i.e. the same
 * host as the configured base but without the `/v1` suffix. Derive it from the
 * OpenAI base URL by stripping a trailing `/v1`.
 */
function pricingUrl(baseUrl: string): string {
  const root = baseUrl.replace(/\/v\d+\/?$/, "") || baseUrl;
  return `${root}/api/pricing`;
}

interface CachedCatalog {
  baseUrl: string;
  fetchedAt: number;
  groupRatio: number;
  entries: NewApiPricingEntry[];
}

function readCache(): CachedCatalog | undefined {
  try {
    if (existsSync(CACHE_PATH)) {
      return JSON.parse(readFileSync(CACHE_PATH, "utf-8")) as CachedCatalog;
    }
  } catch {
    /* malformed cache — ignore */
  }
  return undefined;
}

function writeCache(c: CachedCatalog): void {
  try {
    mkdirSync(agentDir(), { recursive: true });
    // 原子写：tmp + rename，避免进程中断留下半截缓存
    const tmpPath = `${CACHE_PATH}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmpPath, JSON.stringify(c, null, 2), "utf-8");
    renameSync(tmpPath, CACHE_PATH);
  } catch {
    /* non-fatal */
  }
}

/** Name patterns for non-chat models we should not register (image / audio / embedding generators). */
const NON_CHAT = /embedding|dall-?e|\btts\b|\bwhisper\b|suno|stable-?diffusion|midjourney|imagen|bge-|e5-|rerank|moderation/i;

/**
 * 生成可区分、可读的展示名：以 pi 内置目录的漂亮名为基底（只是为了承载思考强度与
 * 展示名），再按网关 id 的变体特征追加标记，避免多个变体（pool-* / 日期后缀）
 * 归一成同一个名字——那样在模型列表里分不清彼此。
 *   - `pool-` 前缀   → 追加 `(Pool)`
 *   - 日期/版本后缀（如 -0731）→ 追加 `(0731)`
 *   - 没有任何变体标记的规范名 → 直接用基底名
 * 内置目录未命中时，把网关 id 可读化（去 pool-、分隔符空格化、首字母大写）兜底。
 */
function displayName(id: string, bi: BuiltinMeta | undefined): string {
  const dateTail = (raw: string): string | undefined => {
    const m = raw.match(/-([0-9]{4,}(?:-[0-9]+)*)$/);
    if (!m) return undefined;
    // 只有 >=4 位数字（日期/临时代号）才算后缀；gemini-2-5 等 1 位不算。
    return m[1].replace(/-/g, "").length >= 4 ? m[1] : undefined;
  };
  const pool = /^pool-/i.test(id);
  const tail = dateTail(id);
  if (bi?.name) {
    const parts: string[] = [bi.name];
    if (pool) parts.push("(Pool)");
    if (tail) parts.push(`(${tail})`);
    return parts.join(" ");
  }
  // 兜底：id 可读化
  let base = /^pool-/i.test(id) ? id.slice(5) : id;
  base = base.replace(/[_-]+/g, " ").trim().replace(/(^|\s)([a-z])/g, (_, s, c) => s + c.toUpperCase());
  const parts: string[] = [base];
  if (pool) parts.unshift("(Pool)");
  if (tail) parts.push(`(${tail})`);
  return parts.join(" ");
}

/** Build a pi ProviderModelConfig from a pricing entry + pi built-in metadata. */
function buildModelConfig(
  entry: NewApiPricingEntry,
  groupRatio: number,
  bi: BuiltinMeta | undefined,
) {
  const id = entry.model_name;
  const vc = detectVendor(id);
  const defs = vendorDefaults(vc.vendor);

  // 字段级来源优先级：pi 内置目录（策展）> vendor 启发式（兜底）。
  const reasoning = bi?.reasoning ?? vc.reasoning;
  const contextWindow = bi?.contextWindow ?? defs.contextWindow;
  const maxTokens = bi?.maxTokens ?? defs.maxTokens;
  const input = bi?.input ?? defs.input;
  // 思考强度（thinkingLevelMap）仅由 pi 内置目录提供。
  const thinkingLevelMap = bi?.thinkingLevelMap;

  // 计费用网关 ratio；固定按次模型（model_price>0）用内置 $/M 近似兜底，避免记成 0。
  const cost = resolveCost(entry, groupRatio, bi?.cost);

  // 兼容参数：先填 vendor 启发式的口径，再让 pi 内置目录（若命中）覆盖为策展值。
  const compat: Record<string, unknown> = {};
  if (vc.thinkingFormat) compat.thinkingFormat = vc.thinkingFormat;
  if (vc.requiresReasoningContentOnAssistantMessages)
    compat.requiresReasoningContentOnAssistantMessages = true;
  if (vc.requiresAssistantAfterToolResult)
    compat.requiresAssistantAfterToolResult = true;
  if (vc.supportsReasoningEffort !== undefined)
    compat.supportsReasoningEffort = vc.supportsReasoningEffort;
  if (vc.maxTokensField) compat.maxTokensField = vc.maxTokensField;
  if (bi?.compat) Object.assign(compat, bi.compat);

  return {
    id,
    name: displayName(id, bi),
    reasoning,
    input,
    cost,
    contextWindow,
    maxTokens,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    ...(Object.keys(compat).length ? { compat } : {}),
  };
}

/** Fetch the pricing catalog; fall back to cache on network failure. */
async function fetchCatalog(
  baseUrl: string,
): Promise<{ entries: NewApiPricingEntry[]; groupRatio: number } | undefined> {
  try {
    const res = await fetch(pricingUrl(baseUrl), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = (await res.json()) as NewApiPricingResponse;
    const groupRatio = pickGroupRatio(payload);
    writeCache({
      baseUrl,
      fetchedAt: Date.now(),
      groupRatio,
      entries: payload.data ?? [],
    });
    return { entries: payload.data ?? [], groupRatio };
  } catch (err) {
    // Fall back to cache if it is for the same base URL.
    const cache = readCache();
    if (cache && cache.baseUrl === baseUrl) {
      return { entries: cache.entries, groupRatio: cache.groupRatio };
    }
    throw new Error(
      `newapi：无法获取 ${pricingUrl(baseUrl)} 且无可用缓存：` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

/** Display width of a string (CJK / fullwidth chars count as 2). */
function dispWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (
      c >= 0x1100 &&
      (c <= 0x115f ||
        (c >= 0x2e80 && c <= 0xa4cf) ||
        (c >= 0xac00 && c <= 0xd7a3) ||
        (c >= 0xf900 && c <= 0xfaff) ||
        (c >= 0xfe30 && c <= 0xfe4f) ||
        (c >= 0xff00 && c <= 0xff60) ||
        (c >= 0xffe0 && c <= 0xffe6))
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

/** padEnd that accounts for double-width CJK chars. */
function padEndDisplay(s: string, width: number): string {
  const w = dispWidth(s);
  return w >= width ? s : s + " ".repeat(width - w);
}

/** Format a token count with thousands separators (e.g. 1,000,000). */
function fmtTokens(n: number | undefined): string {
  return typeof n === "number" ? n.toLocaleString("en-US") : "—";
}

/** Build all model configs from a pricing catalog, dedup by id (first wins). */
function buildModels(
  entries: NewApiPricingEntry[],
  groupRatio: number,
  source: Map<string, string>,
): ReturnType<typeof buildModelConfig>[] {
  const seen = new Map<string, ReturnType<typeof buildModelConfig>>();
  const usedNames = new Set<string>();
  for (const entry of entries) {
    // Skip embedding / non-chat models (e.g. gemini-embedding-*, dall-e, tts, …).
    if (NON_CHAT.test(entry.model_name)) continue;
    const bi = lookupBuiltin(entry.model_name);
    const cfg = buildModelConfig(entry, groupRatio, bi);
    source.set(entry.model_name, bi ? "builtin" : "heuristic");
    // 保证展示名在列表内唯一：冲突时追加序号。
    let name = cfg.name as string;
    if (usedNames.has(name)) {
      let n = 2;
      while (usedNames.has(`${name} (${n})`)) n++;
      name = `${name} (${n})`;
    }
    usedNames.add(name);
    const finalCfg = { ...cfg, name };
    // 同一 id 在 /api/pricing 里可能因 endpoint 类型不同出现多条——保留第一条。
    if (!seen.has(entry.model_name)) seen.set(entry.model_name, finalCfg);
  }
  return [...seen.values()];
}

/**
 * 把当前整理的模型清单原子写入 ~/.pi/agent/models.json（pi 原生配置文件名，
 * 与 ModelConfigSchema 兼容）。这样 pi / 任何读 models.json 的终端/web 都能拿到
 * 一份稳定、可区分、思考强度正确的模型清单，而不是每次依赖插件动态发现的原始名。
 * 该文件由插件自动维护：每次启动（有缓存）与每次刷新目录后都会重写。
 */
function writeModelsJson(
  models: ReturnType<typeof buildModelConfig>[],
  baseUrl: string,
  apiKey: string | undefined,
): void {
  if (!models.length) return;
  const providerModels = models.map((m) => ({
    id: m.id,
    name: m.name,
    ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
    ...(m.input?.length ? { input: m.input } : {}),
    ...(m.cost ? { cost: m.cost } : {}),
    ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
    ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
    ...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
    ...(m.compat && Object.keys(m.compat).length ? { compat: m.compat } : {}),
  }));
  const payload = {
    providers: {
      [PROVIDER_ID]: {
        name: "NewAPI Gateway",
        baseUrl,
        api: "openai-completions",
        authHeader: true,
        ...(apiKey ? { apiKey } : {}),
        models: providerModels,
      },
    },
  };
  try {
    mkdirSync(agentDir(), { recursive: true });
    // 原子写：tmp + rename，避免进程中断留下半截 JSON。
    const tmpPath = `${MODELS_JSON_PATH}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
    renameSync(tmpPath, MODELS_JSON_PATH);
  } catch {
    /* 写 models.json 失败不影响模型发现本身 */
  }
}

/**
 * 供 /newapi-list 展示的摘要（不展开全部模型信息，避免提示过长）。
 */
function summarizeModels(models: ReturnType<typeof buildModelConfig>[]): string {
  return models.map((m) => `${m.id} → ${m.name}`).join(", ");
}

export default async function (pi: ExtensionAPI) {
  // Commands are registered first so they work regardless of whether a base
  // URL is currently configured (lets the user bootstrap from nothing).
  pi.registerCommand("newapi-url", {
    description: "设置 NewAPI 网关地址（例：/newapi-url https://host/v1），保存后自动重新拉取模型列表。",
    async handler(args, ctx) {
      let input = args.trim();
      if (!input) {
        const current = resolveBaseUrl() ?? "（未设置）";
        input = (await ctx.ui.input(`新网关地址（当前：${current}）`, "https://api.example.com/v1")) ?? "";
        if (!input.trim()) {
          ctx.ui.notify("newapi：已取消", "info");
          return;
        }
      }
      const result = normalizeBaseUrl(input);
      if ("error" in result) {
        ctx.ui.notify(`newapi：地址无效 — ${result.error}`, "error");
        return;
      }
      writeConfigFile({ baseUrl: result.url });
      const note = result.appended
        ? `newapi：已规范化为 ${result.url}（自动补 /v1），重新加载…`
        : `newapi：地址已设为 ${result.url}，重新加载…`;
      ctx.ui.notify(note, "info");
      try {
        await ctx.reload();
      } catch (err) {
        ctx.ui.notify(
          `newapi：地址已保存但重新加载失败 — 请重启 pi。（${err instanceof Error ? err.message : String(err)}）`,
          "warning",
        );
      }
    },
  });

  const baseUrl = resolveBaseUrl();

  if (!baseUrl) {
    // No base URL configured: register a minimal shell so `/login newapi`
    // works, then warn. Once configured (config file or env) and reloaded,
    // models appear.
    pi.registerProvider(PROVIDER_ID, {
      name: "NewAPI Gateway",
      baseUrl: "https://placeholder.invalid/v1",
      apiKey: "$NEWAPI_API_KEY",
      api: "openai-completions",
      models: [],
    });
    pi.on("session_start", (_e, ctx) => {
      ctx.ui.notify(
        "newapi：未配置 — 请创建 ~/.pi/agent/newapi-config.json，写入 {\"baseUrl\":\"https://你的网关/v1\",\"apiKey\":\"sk-...\"}，或设置环境变量 NEWAPI_BASE_URL / NEWAPI_API_KEY，然后 /reload",
        "warning",
      );
    });
    return;
  }

  const apiKey = resolveApiKey();
  // Expose the resolved key as $NEWAPI_API_KEY so the provider's env-reference
  // auth resolves it, and so /login newapi can bind (it stores into NEWAPI_API_KEY).
  // Both config-file literal and env var flow through this single env hook.
  if (apiKey) process.env.NEWAPI_API_KEY = apiKey;

  // 记录每个模型的能力元数据来源（builtin / heuristic），供 /newapi-list 显示（避免重复 lookup）。
  const modelSource = new Map<string, string>();

  // ① 先用手头缓存同步出模型列表并立即注册——启动绝不阻塞在网络请求上。
  const cached = readCache();
  let models: ReturnType<typeof buildModelConfig>[] =
    cached && cached.baseUrl === baseUrl ? buildModels(cached.entries, cached.groupRatio, modelSource) : [];
  let fetchError: string | undefined;

  const providerConfig = (): Parameters<typeof pi.registerProvider>[1] => ({
    name: "NewAPI Gateway",
    baseUrl,
    api: "openai-completions" as Api,
    apiKey: "$NEWAPI_API_KEY", // env reference → /login newapi binds; value injected above
    authHeader: true, // OpenAI-compatible: Authorization: Bearer <key>
    models,
  });

  pi.registerProvider(PROVIDER_ID, providerConfig());
  // 启动不等待网络：先把缓存整理出的清单同步维护进 models.json（若已有模型）。
  if (models.length) writeModelsJson(models, baseUrl, apiKey);

  // 共享的刷新逻辑：拉取目录 → 用最新结果替换注册，并同步维护 models.json。启动与 /newapi-refresh 都复用它。
  const refreshCatalog = async (): Promise<void> => {
    try {
      const catalog = await fetchCatalog(baseUrl);
      if (catalog) {
        modelSource.clear();
        models = buildModels(catalog.entries, catalog.groupRatio, modelSource);
        pi.registerProvider(PROVIDER_ID, providerConfig());
        writeModelsJson(models, baseUrl, apiKey);
      }
    } catch (err) {
      fetchError = err instanceof Error ? err.message : String(err);
      throw err; // 让调用方决定是否上报
    }
  };

  // ② 后台异步执行一次刷新（启动不阻塞；失败静默，留给 session_start 报）。
  void refreshCatalog().catch(() => {});

  pi.registerCommand("newapi-list", {
    description: "列出已发现的 NewAPI 模型，含上下文窗口、最大输出、推理能力及元数据来源。",
    async handler(_args, ctx) {
      if (!models.length) {
        ctx.ui.notify("newapi：暂无模型 — 请先用 /newapi-url 设置网关地址", "warning");
        return;
      }
      const cols = ["模型", "上下文", "输出", "推理", "输入", "来源"];
      const rows = models.map((m) => {
        return [
          m.id,
          fmtTokens(m.contextWindow),
          fmtTokens(m.maxTokens),
          m.reasoning ? "✓" : "–",
          m.input && m.input.length ? m.input.join("/") : "—",
          modelSource.get(m.id) ?? "heuristic",
        ] as string[];
      });
      const W = cols.map((h, i) =>
        Math.max(dispWidth(h), ...rows.map((r) => dispWidth(r[i]))),
      );
      const line = (cells: string[]) =>
        cells.map((c, i) => padEndDisplay(c, W[i])).join("  ");
      const lines: string[] = [];
      lines.push(`NewAPI 模型（共 ${models.length} 个）`);
      lines.push("");
      lines.push(line(cols));
      lines.push("─".repeat(dispWidth(line(cols))));
      for (const r of rows) lines.push(line(r));
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("newapi-refresh", {
    description: "立即重新拉取 NewAPI 模型目录（无需 /reload / 重启）。",
    async handler(_args, ctx) {
      ctx.ui.notify("newapi：正在刷新模型目录…", "info");
      try {
        await refreshCatalog();
        ctx.ui.notify(`newapi：已刷新，共 ${models.length} 个模型（已同步维护 models.json）\n${summarizeModels(models)}`, "info");
      } catch (err) {
        ctx.ui.notify(
          `newapi：刷新失败 — ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("newapi-write-models", {
    description: "把当前 NewAPI 模型清单重新写入 ~/.pi/agent/models.json（自动维护，一般不必手动）。",
    async handler(_args, ctx) {
      if (!models.length) {
        ctx.ui.notify("newapi：暂无模型 — 请先用 /newapi-refresh 成功拉取后再试", "warning");
        return;
      }
      writeModelsJson(models, baseUrl, apiKey);
      ctx.ui.notify(`newapi：已写入 models.json，共 ${models.length} 个模型`, "info");
    },
  });

  pi.on("session_start", (_e, ctx) => {
    if (fetchError) {
      ctx.ui.notify(`newapi：模型发现失败 — ${fetchError}`, "error");
      return;
    }
    // 真正的"有无 key"以 pi 的鉴权状态为准：/login 存入的 CredentialStore（auth.json）也算已配置。
    const configured = ctx.modelRegistry?.getProviderAuthStatus?.(PROVIDER_ID)?.configured === true;
    const hasKey = !!apiKey || configured;
    if (!hasKey) {
      ctx.ui.notify(
        "newapi：未设置 API key — 请在 ~/.pi/agent/newapi-config.json 里设 apiKey，或运行 /login newapi",
        "warning",
      );
    } else if (models.length > 0) {
      ctx.ui.notify(`newapi：${models.length} 个模型可用`, "info");
    }
  });
}
