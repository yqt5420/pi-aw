/**
 * pi-auto-title — 自动为新会话生成一句话简洁标题。
 *
 * 原理：pi 本身不内置自动对话标题，会话显示名默认取首条消息或手动 `/name`。
 * 本扩展在用户每次提交 prompt、agent 启动前（before_agent_start）把首条消息
 * 交给一个 OpenAI 兼容的 LLM 端点，生成 ≤ 20 字的标题后调用 `pi.setSessionName()`
 * 写回，显示在 `/resume` 会话选择器里。已手动 `/name` 的会话不会被覆盖，也不会
 * 反复重命名。
 *
 * 配置（环境变量）：
 *   - AUTO_TITLE_BASE / AUTO_TITLE_API_KEY / AUTO_TITLE_MODEL
 *   未配置时向后兼容地回退到 NEWAPI_BASE_URL / NEWAPI_API_KEY（配合 pi-newapi）。
 *   端点需提供 OpenAI 兼容的 POST {base}/chat/completions。
 *   - AUTO_TITLE_MAX （可选，默认 20）：标题最大字符数。
 *
 * LLM 生成失败（端点不可达 / 配置缺失）时静默跳过，绝不阻塞或中断正常对话。
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

const GEN_TIMEOUT_MS = 6000;

// 本进程内已经(尝试)命名过的会话文件，避免每次 turn 反复生成。
const handled = new Set<string>();

/* --------------------------- 生命周期钩子 --------------------------- */

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const prompt = (event.prompt ?? "").trim();
      if (!prompt) return;

      // 会话未落盘（ephemeral）就没必要命名；每会话只处理一次。
      const file = ctx.sessionManager.getSessionFile?.();
      if (!file) return;
      if (handled.has(file)) return;

      // 已有名字（手动 /name 或本扩展/其它来源设置过）则尊重不再覆盖。
      const existing = ctx.sessionManager.getSessionName?.();
      if (existing) {
        handled.add(file);
        return;
      }

      if (!LLM_BASE || !LLM_MODEL || !LLM_API_KEY) {
        handled.add(file); // 配置缺失：跳过并标记，避免重复尝试
        return;
      }

      handled.add(file); // 先占位，避免生成失败后下一 turn 反复打端点

      const title = await genTitle(prompt);
      if (title) pi.setSessionName(title);
    } catch {
      /* 任何异常都不影响正常对话 */
    }
  });
}

/* ------------------------------ 核心逻辑 ------------------------------ */

/** 用首条 prompt 生成 ≤ TITLE_MAX 字的一句话标题，失败返回 null。 */
async function genTitle(prompt: string): Promise<string | null> {
  const controller = AbortSignal.timeout(GEN_TIMEOUT_MS);
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
        max_tokens: 64,
        messages: [
          {
            role: "system",
            content:
              `为下面的首条用户消息生成一句对话标题。` +
              `要求：${TITLE_MAX} 个字符以内、简洁贴近主题、不要引号/冒号/标签/解释。只输出标题本身。`,
          },
          { role: "user", content: prompt.slice(0, 800) },
        ],
      }),
      signal: controller,
    });
  } catch {
    return null; // 超时 / 网络失败
  }

  if (!res.ok) return null;

  let data: { choices?: { message?: { content?: string } }[] };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    return null;
  }

  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) return null;

  const cleaned = text
    .replace(/^["'“”‘’《》]+|["'“”‘’《》]+$/g, "") // 去掉首尾引号书名号
    .slice(0, TITLE_MAX);

  return cleaned || null;
}

/** 环境变量整数解析，越界/非法回退到默认值。 */
function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}