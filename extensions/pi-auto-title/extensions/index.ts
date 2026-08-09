/**
 * pi-auto-title — 自动为新会话生成一句话简洁标题。
 *
 * 原理：pi 本身不内置自动对话标题，会话显示名默认取首条消息或手动 `/name`。
 * 本扩展在用户每次提交 prompt、agent 启动前（before_agent_start）把首条消息
 * 交给 LLM 生成 ≤ 20 字的标题后调用 `pi.setSessionName()` 写回，显示在 `/resume`
 * 会话选择器里。
 *
 * ⚠ 模型解析（v2 修复）：
 *   - 优先复用【会话当前正在使用的模型】：`ctx.model`（含 id / baseUrl / api / headers）
 *     + `ctx.modelRegistry.getApiKeyAndHeaders(model)`（解析当前 provider 的 API key 与认证头）。
 *     用户 `/model` 选过什么，标题就用什么，无需为标题功能单独配置任何东西。
 *   - 仅当会话当前模型不可用或取不到凭据时，才回退到显式环境变量
 *     AUTO_TITLE_BASE / AUTO_TITLE_API_KEY / AUTO_TITLE_MODEL，再回退 NEWAPI_*。
 *   不配置任何东西 → 自动跟随会话模型，开箱即用。
 *
 * 可靠性设计：
 *   - 已手动 `/name` 的会话不被覆盖；
 *   - 生成失败不永久放弃：冷却 COOLDOWN_MS 后下一 turn 重试；
 *   - 网关偶发返回空 content 时内部重试最多 EMPTY_RETRIES 次；
 *   - 任何异常都不阻塞、不中断正常对话。
 *
 * 配置（环境变量，均为可选的 fallback）：
 *   - AUTO_TITLE_BASE   ：base URL，未设时回退 NEWAPI_BASE_URL
 *   - AUTO_TITLE_API_KEY：API Key，未设时回退 NEWAPI_API_KEY
 *   - AUTO_TITLE_MODEL  ：模型 id，未设时用会话当前模型
 *   - AUTO_TITLE_MAX    ：标题最大字符数，默认 20，范围 10–40
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/* ------------------------------ 配置（fallback，运行时读取） ------------------------------ */

// fallback 端点参数在每次调用时从 env 实时读取（而非 import 时截获），
// 这样既支持启动时 setenv，也支持运行时注入后即时生效。
function getFallbackBase(): string {
  return process.env.AUTO_TITLE_BASE?.trim() || process.env.NEWAPI_BASE_URL?.trim() || "";
}
function getFallbackApiKey(): string {
  return process.env.AUTO_TITLE_API_KEY?.trim() || process.env.NEWAPI_API_KEY?.trim() || "";
}
function getFallbackModel(): string {
  return process.env.AUTO_TITLE_MODEL?.trim() || "";
}
const TITLE_MAX = clampInt(process.env.AUTO_TITLE_MAX, 10, 40, 20);

const GEN_TIMEOUT_MS = 10000; // 单次 LLM 调用最大等待（慢=立即放弃，留给冷却重试）
const EMPTY_RETRIES = 3; // 仅对"快速返回空 content"重试，避免拖慢 agent 启动
const COOLDOWN_MS = 20000; // 生成失败后多久才允许再次尝试

/* ------------------- 会话级状态（仅进程内存活） ------------------- */

// 已成功命名（或已存在手动名字）的会话文件 -> 不再改
const succeeded = new Set<string>();
// 最近一次尝试时间戳，用于失败的冷却重试
const lastAttempt = new Map<string, number>();

/* --------------------------- 生命周期钩子 --------------------------- */

/** 本次调用所需的 LLM 端点参数（运行时由当前会话解析） */
interface TitleEndpoint {
  base: string;
  /** model 在请求体里的 id */
  modelId: string;
  apiKey: string;
  /** 附加/认证请求头（来自当前 provider 的认证解析） */
  headers?: Record<string, string>;
  /** model api 类型，用于选择端点路径（anthropic 用 /messages，其余用 /chat/completions） */
  api: string;
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const prompt = (event.prompt ?? "").trim();
      if (!prompt) return;

      // 会话未落盘（ephemeral）不命名；每会话只处理一次成功结果。
      const file = ctx.sessionManager.getSessionFile?.();
      if (!file) return;
      if (succeeded.has(file)) return;

      // 已有名字（手动 /name 或其它来源设置过）则尊重不再覆盖。
      const existing = ctx.sessionManager.getSessionName?.();
      if (existing) {
        succeeded.add(file);
        return;
      }

      // 解析标题生成端点：优先复用会话当前模型与凭据。
      const ep = await resolveEndpoint(ctx);
      if (!ep) {
        // 当前模型不可用且无任何 fallback 配置：视为无此功能，不反复尝试。
        succeeded.add(file);
        return;
      }

      // 失败冷却：避免端点不可用时每 turn 都打请求。
      const now = Date.now();
      if (now - (lastAttempt.get(file) ?? 0) < COOLDOWN_MS) return;
      lastAttempt.set(file, now);

      const title = await genTitle(prompt, ep);
      if (!title) {
        // 仍失败：不标记成功，冷却后允许重试；绝不阻塞对话。
        return;
      }

      succeeded.add(file);
      pi.setSessionName(title);
    } catch {
      /* 任何异常都不影响正常对话 */
    }
  });
}

/**
 * 解析标题使用的端点。优先级：
 *   1. 会话当前模型 `ctx.model` + `ctx.modelRegistry.getApiKeyAndHeaders(model)`；
 *   2. 显式环境变量 AUTO_TITLE_*；
 *   3. NEWAPI_* 兼容回退。
 * 任一项都拿不到（无 base / 无 model id / 无 apiKey）返回 null。
 */
async function resolveEndpoint(ctx: ExtensionContext): Promise<TitleEndpoint | null> {
  // ---- 优先：会话当前模型 ----
  const model = ctx.model;
  if (model?.id) {
    const base = model.baseUrl?.trim().replace(/\/+$/, "") || "";
    let apiKey = "";
    let headers: Record<string, string> | undefined;
    try {
      const auth = await ctx.modelRegistry?.getApiKeyAndHeaders(model);
      if (auth?.ok) {
        apiKey = auth.apiKey?.trim() || "";
        if (auth.headers && Object.keys(auth.headers).length) headers = auth.headers;
      }
    } catch {
      /* 取不到则走 fallback */
    }
    // 当前模型有 id + base + 凭据，直接用（最贴合"会话在用什么就用什么"）。
    if (base && apiKey) {
      return {
        base,
        modelId: model.id,
        apiKey,
        headers,
        api: model.api || "openai-completions",
      };
    }
    // 若当前模型有 id+base 但缺 apiKey，尝试按 provider 直接取 key 一次。
    if (base && !apiKey) {
      try {
        apiKey = (await ctx.modelRegistry?.getApiKeyForProvider(model.provider))?.trim() || "";
      } catch {
        /* ignore */
      }
      if (apiKey) {
        return { base, modelId: model.id, apiKey, headers, api: model.api || "openai-completions" };
      }
    }
  }

  // ---- fallback：显式 AUTO_* -> NEWAPI_*（运行时读取） ----
  const base = getFallbackBase();
  const modelId = getFallbackModel();
  const apiKey = getFallbackApiKey();
  if (base && modelId && apiKey) {
    return { base, modelId, apiKey, api: "openai-completions" };
  }
  return null;
}

/* ------------------------------ 核心逻辑 ------------------------------ */

/** 用首条 prompt 生成 ≤ TITLE_MAX 字的一句话标题，最终仍失败返回 null。 */
async function genTitle(prompt: string, ep: TitleEndpoint): Promise<string | null> {
  const userMsg = prompt.slice(0, 800);
  let emptyCount = 0;
  for (let attempt = 0; attempt < 1 + EMPTY_RETRIES; attempt++) {
    const r = await callOnce(userMsg, ep);
    if (r.kind === "ok") return r.title;
    // 只在"快速返回空"时重试；超时/错误立即放弃，避免阻塞 agent 启动。
    if (r.kind !== "empty") return null;
    emptyCount++;
    if (emptyCount > EMPTY_RETRIES) return null;
  }
  return null;
}

/** 单次 LLM 调用，返回结果与失败类型。 */
async function callOnce(
  userMsg: string,
  ep: TitleEndpoint,
): Promise<
  | { kind: "ok"; title: string }
  | { kind: "empty" }
  | { kind: "error" }
> {
  const isAnthropic = String(ep.api).toLowerCase().startsWith("anthropic");
  const base = ep.base.replace(/\/+$/, "");
  const url = isAnthropic ? `${base}/messages` : `${base}/chat/completions`;

  // 组装请求头：先放解析得到的认证头（避免重复加），缺认证再补。
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let authSet = false;
  for (const [k, v] of Object.entries(ep.headers ?? {})) {
    if (v == null) continue;
    headers[k] = String(v);
    if (/^(authorization|x-api-key|api-key)$/i.test(k) && String(v).trim()) authSet = true;
  }
  if (!authSet && ep.apiKey) {
    if (isAnthropic) {
      headers["x-api-key"] = ep.apiKey;
      headers["anthropic-version"] = headers["anthropic-version"] || "2023-06-01";
    } else {
      headers["Authorization"] = `Bearer ${ep.apiKey}`;
    }
  }

  const system =
    `为下面的首条用户消息生成一句对话标题。` +
    `要求：${TITLE_MAX} 个字符以内、简洁贴近主题、不要引号/冒号/标签/解释。只输出标题本身。`;

  const body = isAnthropic
    ? {
        model: ep.modelId,
        max_tokens: 200,
        temperature: 0.3,
        system,
        messages: [{ role: "user" as const, content: userMsg }],
      }
    : {
        model: ep.modelId,
        temperature: 0.3,
        max_tokens: 512,
        messages: [
          { role: "system" as const, content: system },
          { role: "user" as const, content: userMsg },
        ],
      };

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GEN_TIMEOUT_MS),
    });
  } catch {
    return { kind: "error" }; // 网络失败 / 超时
  }

  if (!res.ok) return { kind: "error" };

  let data: { choices?: { message?: { content?: string } }[] } | { content?: Array<{ type?: string; text?: string }> };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    return { kind: "error" };
  }

  let text = "";
  if (isAnthropic) {
    const entries = (data as { content?: Array<{ type?: string; text?: string }> }).content;
    text = (entries?.find((e) => e.type === "text")?.text ?? "").trim();
  } else {
    text = ((data as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "").trim();
  }
  if (!text) return { kind: "empty" }; // 网关偶发返回空 content

  const cleaned = text
    .replace(/^["'“”‘’《》「」]+|["'“”‘’《》「」]+$/g, "") // 去掉首尾引号/书名号/角括号
    .slice(0, TITLE_MAX);

  return cleaned ? { kind: "ok", title: cleaned } : { kind: "empty" };
}

/** 环境变量整数解析，越界/非法回退到默认值。 */
function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}