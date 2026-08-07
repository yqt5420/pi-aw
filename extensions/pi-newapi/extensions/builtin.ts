/**
 * pi 内置模型目录 — 上下文/输出/推理/思考强度（thinkingLevelMap）及 compat 的唯一来源。
 *
 * pi 自带的内置目录（@earendil-works/pi-ai 随包静态打包，无需网络）同时给出：
 *   contextWindow / maxTokens / reasoning / input / compat / thinkingLevelMap
 * （思考强度各档 → 厂商参数的映射，启发式只能给布尔 `reasoning`，给不出档位）。
 *
 * NewAPI 网关的模型 id 常与内置规范 id 不完全一致——多带 `pool-` 前缀，或者带临时的
 * 日期/版本代号（例如 deepseek-v4-flash-0731，`-0731` 只是这段时间的代号，本体还是
 * deepseek-v4-flash）。因此在**精确匹配失败后**，这里会剥掉 `pool-` 前缀与这类临时
 * 后缀再去命中基础模型，把基模型的思考档位顺带继承过来。
 *
 * 仍未命中时返回 undefined，由调用方回落到 vendor-detect.ts 的启发式兜底。
 */

import { getModels, type BuiltinProvider } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";

/** 从内置目录提取、符合 ProviderModelConfig 形状的元数据片段。 */
export interface BuiltinMeta {
  /** 展示名（pi 内置目录里的漂亮名字）。 */
  name?: string;
  /** 是否推理/thinking 模型。 */
  reasoning?: boolean;
  /** 思考强度档位映射（pi 各档 → 模型/厂商参数；null 表示不支持该档）。 */
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  /** 上下文窗口（tokens）。 */
  contextWindow?: number;
  /** 最大输出（tokens）。 */
  maxTokens?: number;
  /** 输入模态。 */
  input?: ("text" | "image")[];
  /** OpenAI 兼容性参数（thinkingFormat / requiresReasoningContent… 等）。 */
  compat?: Model<Api>["compat"];
  /** 每 M token 成本（仅作固定按次计费模型的近似兜底，正常仍用网关 ratio 计价）。 */
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** 参与能力继承的内置厂商（顺序即优先级）：多个内置厂商命中同一规范化 id 时保留策展值。 */
const ENRICHMENT_PROVIDERS: readonly BuiltinProvider[] = [
  "deepseek",
  "zai",
  "google",
  "anthropic",
  "minimax",
  "moonshotai",
  "xiaomi",
  "openai",
  "vercel-ai-gateway",
];

let cachedLookup: Map<string, BuiltinMeta> | undefined;

/**
 * 规范化：去 provider 前缀（`deepseek/xxx`→`xxx`）、剥 `pool-`、分隔符统一为 `-`、
 * 小写、去重复与首尾 `-`。保留临时代号（如 `-0731`），留给下方变体命中处理。
 */
function normalize(id: string): string {
  let s = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
  s = s.replace(/^pool-/i, "");
  s = s.replace(/[\s_.]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return s.toLowerCase();
}

/** 若命中带临时后缀后到的基础规范 id，生成其候选（不含精确 id 本身）。 */
function strippedCandidates(base: string): string[] {
  const out: string[] = [];
  // 末尾数字组（>=4 位数字才算临时代号/日期）：deepseek-v4-flash-0731 → deepseek-v4-flash，
  // gpt-4o-mini-2024-07-18 → gpt-4o-mini；但 gemini-2-5 末尾只有 1 位数字，不剥。
  const m = base.match(/-([0-9]+(?:-[0-9]+)*)$/);
  if (m) {
    const digits = m[1].replace(/-/g, "");
    if (digits.length >= 4) out.push(base.slice(0, base.length - m[0].length));
  }
  // 无歧义的临时别名后缀。
  for (const w of ["latest", "snapshot", "pinned"]) {
    if (base.endsWith(`-${w}`)) out.push(base.slice(0, base.length - w.length - 1));
  }
  return out;
}

function extractBuiltinMeta(model: Model<Api>): BuiltinMeta {
  return {
    name: model.name,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    input: model.input,
    compat: model.compat,
    cost: model.cost,
  };
}

function buildLookup(): Map<string, BuiltinMeta> {
  const lookup = new Map<string, BuiltinMeta>();
  for (const provider of ENRICHMENT_PROVIDERS) {
    let models: Model<Api>[];
    try {
      models = getModels(provider) as Model<Api>[];
    } catch {
      // 该厂商在内置目录缺失/读取失败——跳过，不拖垮整体。
      continue;
    }
    for (const model of models) {
      const key = normalize(model.id);
      if (!key || lookup.has(key)) continue; // 首个命中的厂商优先
      lookup.set(key, extractBuiltinMeta(model));
    }
  }
  return lookup;
}

function getLookup(): Map<string, BuiltinMeta> {
  if (!cachedLookup) cachedLookup = buildLookup();
  return cachedLookup;
}

/** 允许重载 / 测试时重置内存目录。 */
export function resetBuiltinCache(): void {
  cachedLookup = undefined;
}

/**
 * 按网关模型 id 查找 pi 内置目录。先精确匹配；失败后剥掉 `pool-` 前缀与
 * 日期/版本代号（-0731 / -20250514 / -latest 等）再命中基础模型。
 */
export function lookupBuiltin(modelId: string): BuiltinMeta | undefined {
  const base = normalize(modelId);
  if (!base) return undefined;
  const lookup = getLookup();
  const exact = lookup.get(base);
  // 精确命中且已带思考档位 → 直接用（最具体，信息也够）。
  if (exact?.thinkingLevelMap) return exact;
  // 否则继续剥掉 pool-、临时代号（-0731 / -latest 等）命中基础模型。
  // 注意：像 vercel-ai-gateway 这类代理厂商会用“带日期的 id”精确命中（例如
  // deepseek-v4-flash-0731）但自身不带 thinkingLevelMap，会挡在生产厂商那条
  // 带档位的记录前面——因此这里优先反向取“更富”（含 thinkingLevelMap）的命中。
  let best = exact;
  for (const cand of strippedCandidates(base)) {
    const c = lookup.get(cand);
    if (!c) continue;
    if (!best) {
      best = c;
      continue;
    }
    if (c.thinkingLevelMap && !best.thinkingLevelMap) best = c;
  }
  return best;
}