/**
 * pi-auto-title — 自动为新会话生成一句话简洁标题。
 *
 * 原理：pi 本身不内置自动对话标题，会话显示名默认取首条消息或手动 `/name`。
 * 本扩展在用户每次提交 prompt、agent 启动前（before_agent_start）把首条消息
 * 交给一个 OpenAI 兼容的 LLM 端点，生成 ≤ 20 字的标题后调用 `pi.setSessionName()`
 * 写回，显示在 `/resume` 会话选择器里。
 *
 * 可靠性设计：
 *   - 已手动 `/name` 的会话不被覆盖；
 *   - 生成失败不永久放弃：冷却 COOLDOWN_MS 后下一 turn 重试；
 *   - 网关偶发返回空 content 时内部重试最多 GEN_MAX_ATTEMPTS 次；
 *   - 任何异常都不阻塞、不中断正常对话。
 *
 * 配置（环境变量）：
 *   - AUTO_TITLE_BASE / AUTO_TITLE_API_KEY / AUTO_TITLE_MODEL
 *   未配置时向后兼容地回退到 NEWAPI_BASE_URL / NEWAPI_API_KEY（配合 pi-newapi）。
 *   端点需提供 OpenAI 兼容的 POST {base}/chat/completions。
 *   - AUTO_TITLE_MAX （可选，默认 20）：标题最大字符数。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/* ------------------------------ 配置 ------------------------------ */

const LLM_BASE =
  process.env.AUTO_TITLE_BASE?.trim() || process.env.NEWAPI_BASE_URL?.trim() || "";
const LLM_API_KEY =
  process.env.AUTO_TITLE_API_KEY?.trim() ||
  process.env.NEWAPI_API_KEY?.trim() ||
  "";
const LLM_MODEL = process.env.AUTO_TITLE_MODEL?.trim() || "";
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

      // 配置缺失：直接跳过（视为无此功能），不反复尝试。
      if (!LLM_BASE || !LLM_MODEL || !LLM_API_KEY) {
        succeeded.add(file);
        return;
      }

      // 失败冷却：避免网关不可用时每 turn 都打端点。
      const now = Date.now();
      if (now - (lastAttempt.get(file) ?? 0) < COOLDOWN_MS) return;
      lastAttempt.set(file, now);

      const title = await genTitle(prompt);
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

/* ------------------------------ 核心逻辑 ------------------------------ */

/** 用首条 prompt 生成 ≤ TITLE_MAX 字的一句话标题，最终仍失败返回 null。 */
async function genTitle(prompt: string): Promise<string | null> {
  const userMsg = prompt.slice(0, 800);
  let emptyCount = 0;
  for (let attempt = 0; attempt < 1 + EMPTY_RETRIES; attempt++) {
    const r = await callOnce(userMsg);
    if (r.kind === "ok") return r.title;
    // 只在"快速返回空"时重试；超时/错误立即放弃，避免阻塞 agent 启动。
    if (r.kind !== "empty") return null;
    emptyCount++;
    if (emptyCount > EMPTY_RETRIES) return null;
  }
  return null;
}

/** 单次 LLM 调用，返回结果与失败类型。 */
async function callOnce(userMsg: string): Promise<
  | { kind: "ok"; title: string }
  | { kind: "empty" }
  | { kind: "error" }
> {
  if (!LLM_MODEL) return { kind: "error" };
  let res: Response;
  try {
    res = await fetch(`${LLM_BASE.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        temperature: 0.3,
        max_tokens: 512,
        messages: [
          {
            role: "system",
            content:
              `为下面的首条用户消息生成一句对话标题。` +
              `要求：${TITLE_MAX} 个字符以内、简洁贴近主题、不要引号/冒号/标签/解释。只输出标题本身。`,
          },
          { role: "user", content: userMsg },
        ],
      }),
      signal: AbortSignal.timeout(GEN_TIMEOUT_MS),
    });
  } catch {
    return { kind: "error" }; // 网络失败 / 超时
  }

  if (!res.ok) return { kind: "error" };

  let data: { choices?: { message?: { content?: string } }[] };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    return { kind: "error" };
  }

  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) return { kind: "empty" }; // 网关偶发返回空 content

  const cleaned = text
    .replace(/^["'“”‘’《》]+|["'“”‘’《》]+$/g, "") // 去掉首尾引号书名号
    .slice(0, TITLE_MAX);

  return cleaned ? { kind: "ok", title: cleaned } : { kind: "empty" };
}

/** 环境变量整数解析，越界/非法回退到默认值。 */
function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}