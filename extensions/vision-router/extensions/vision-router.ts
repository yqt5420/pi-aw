import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { randomInt } from "node:crypto";
import { deflateSync } from "node:zlib";

/**
 * vision-router — pi 视觉通道自动维护 + 路由扩展
 *
 * 核心能力：
 *  1. 自动扫描 pi 当前所有可用模型（ctx.modelRegistry.getAvailable()），
 *     记录每个模型的 input 声明（是否含 image）。
 *  2. 对模型做图证实测（发含随机数字的大图，答对才算支持视觉），防止网关元数据不准确。
 *  3. 维护"可用视觉通道"列表，缓存到 ~/.pi/agent/vision-channels.json。
 *  4. 路由：主模型读图失败时，从维护列表选可识图模型兜底：
 *       同 provider 优先 → 其他视觉模型 → 外部免费 GLM/Agnes。
 *
 * 健壮性设计（v2，按 review 修复）：
 *  - 每个 fetch 都有超时（AbortSignal.any + 超时控制器）
 *  - 状态文件原子写（tmp + rename）
 *  - 扫描互斥（单飞，防定时器/手动并发）
 *  - 测试判定区分「不支持视觉」vs「通道故障」
 *  - 大图编码只做一次复用
 *  - 失败用 throw（isError 字段不被 pi 接受）
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const STATE_FILE = join(homedir(), ".pi", "agent", "vision-channels.json");
const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 分钟
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 缓存 24h 有效
const TEST_TIMEOUT_MS = 30_000;
const ROUTE_TIMEOUT_MS = 30_000; // 正式路由每通道超时
const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15MB 上限

const NON_VISION_KEYWORDS = ["does not support images", "image will be omitted"];
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"]);
const MIME_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

/** 图证测试 prompt：要求模型读出图里的数字。数字本身不在 prompt 里，模型无法靠文本猜中。 */
const VISION_TEST_PROMPT = "Read the number shown in the image. Reply with only the digits, nothing else.";

/** 视觉不支持的关键词（用于 4xx 错误体判定） */
const VISION_UNSUPPORTED_RE =
  /(image.*(not\s+support|unsupported|invalid|cannot|cannot|doesn'?t\s+support|not\s+allowed|no\s+vision)|(not\s+support|unsupported|invalid).*image)/i;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

interface VisionChannel {
  provider: string;
  model: string;
  baseUrl: string;
  api: string;
  /** true=实测支持视觉 */
  vision: boolean;
  /** true=实测失败且错误明确表示不支持视觉 */
  visionUnsupported?: boolean;
  /** true=通道故障（网络/认证/超时，非不支持） */
  channelError?: boolean;
  /** 最后实测时间戳 */
  lastTested?: number;
  /** 实测错误信息 */
  lastError?: string;
}

interface State {
  channels: VisionChannel[];
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// 状态读写（原子写 + 容错读）
// ---------------------------------------------------------------------------

function readState(): State {
  try {
    if (existsSync(STATE_FILE)) {
      const raw = readFileSync(STATE_FILE, "utf-8");
      const data = JSON.parse(raw) as State;
      if (Array.isArray(data.channels)) return data;
    }
  } catch (err) {
    console.error(`[vision-router] 读取状态失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { channels: [], updatedAt: 0 };
}

function writeState(state: State): void {
  try {
    const dir = dirname(STATE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // 原子写：tmp + rename，避免进程中断留下半截 JSON
    const tmpPath = `${STATE_FILE}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
    renameSync(tmpPath, STATE_FILE);
  } catch (err) {
    console.error(`[vision-router] 写入状态失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function isImagePath(p: string): boolean {
  const dot = p.lastIndexOf(".");
  if (dot < 0) return false;
  return IMAGE_EXTS.has(p.slice(dot).toLowerCase());
}

/** 编码图片为 data URL（带大小限制，只编码一次） */
function encodeImageDataUrl(imagePath: string): string {
  const dot = imagePath.lastIndexOf(".");
  const ext = imagePath.slice(dot).toLowerCase();
  const mime = MIME_MAP[ext] ?? "image/jpeg";
  const buf = readFileSync(imagePath);
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new Error(`图片过大（${(buf.length / 1024 / 1024).toFixed(1)}MB），上限 15MB`);
  }
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/** 组合超时与取消信号 */
function withTimeout(
  signal: AbortSignal | null | undefined,
  timeoutMs: number,
): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const combined =
    signal && typeof AbortSignal.any === "function"
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
  return { signal: combined, clear: () => clearTimeout(timer) };
}

// ---------------------------------------------------------------------------
// 模型视觉实测
// ---------------------------------------------------------------------------

// 图证测试图生成：渲染含随机数字的大尺寸 PNG（≥300px、高对比、四周留白）。
// 数字不进任何 prompt，模型必须真正读图才能答对 —— 消除 prompt 泄密假阳与小图假阴。
const DIGIT_FONT: Record<string, string[]> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
};
const FONT_SCALE = 24; // 每个字体像素放大 24×，保证 ≥50px、清晰可读
const IMG_PAD = 20; // 四周留白

function crc32(buf: Buffer): number {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  let c = ~0 >>> 0;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** 生成含指定数字的 PNG（base64）。深字浅底、大尺寸，数字不写入任何 prompt。 */
function makeNumberPng(num: number): string {
  const s = String(num);
  const digitsW = s.length * 5 * FONT_SCALE;
  const digitsH = 7 * FONT_SCALE;
  const W = digitsW + IMG_PAD * 2;
  const H = digitsH + IMG_PAD * 2;
  const raw: number[] = [];
  for (let y = 0; y < H; y++) {
    raw.push(0); // PNG scanline filter
    for (let x = 0; x < W; x++) {
      let on = false;
      if (x >= IMG_PAD && x < IMG_PAD + digitsW && y >= IMG_PAD && y < IMG_PAD + digitsH) {
        const lx = x - IMG_PAD;
        const ly = y - IMG_PAD;
        const di = Math.floor(lx / (5 * FONT_SCALE));
        const fc = Math.floor(lx / FONT_SCALE) % 5;
        const fr = Math.floor(ly / FONT_SCALE);
        const glyph = DIGIT_FONT[s[di]];
        on = !!glyph && !!glyph[fr] && glyph[fr][fc] === "1";
      }
      raw.push(on ? 20 : 235, on ? 20 : 235, on ? 20 : 235);
    }
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.from(raw))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

async function testModelVision(
  model: { id: string; baseUrl: string },
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
  signal?: AbortSignal | null,
): Promise<{ ok: boolean; unsupported: boolean; error?: string }> {
  const { signal: combined, clear } = withTimeout(signal, TEST_TIMEOUT_MS);
  try {
    // 每次调用一个新随机数 → 模型无法靠猜/记忆过关
    const num = randomInt(10000, 99999);
    const url = `${model.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const payload = {
      model: model.id,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:image/png;base64,${makeNumberPng(num)}` } },
            { type: "text", text: VISION_TEST_PROMPT },
          ],
        },
      ],
      max_tokens: 400,
    };

    const hdrs: Record<string, string> = {
      "Content-Type": "application/json",
      ...(headers ?? {}),
    };
    if (apiKey) hdrs.Authorization = `Bearer ${apiKey}`;

    const resp = await fetch(url, {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify(payload),
      signal: combined,
    });

    // 非 2xx：解析错误体，区分「不支持视觉」vs「通道故障」
    if (!resp.ok) {
      let errMsg = `HTTP ${resp.status} ${resp.statusText}`;
      let unsupported = false;
      try {
        const body = (await resp.json()) as { error?: { message?: string } };
        const detail = body.error?.message;
        if (detail) {
          errMsg = `${errMsg}: ${detail}`;
          unsupported = VISION_UNSUPPORTED_RE.test(detail) || /image|vision|photo/i.test(detail);
        }
      } catch {
        /* 错误体不是 JSON */
      }
      if ((resp.status === 400 || resp.status === 415) && !unsupported) {
        unsupported = /image|vision/i.test(errMsg);
      }
      return { ok: false, unsupported, error: errMsg.slice(0, 300) };
    }

    const data = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
    };
    if (data.error) {
      const msg = data.error.message ?? "API error";
      return { ok: false, unsupported: VISION_UNSUPPORTED_RE.test(msg), error: msg.slice(0, 300) };
    }
    const content = data.choices?.[0]?.message?.content ?? "";
    // 图证判定：回复必须含该随机数字才算真识图（数字不在 prompt 里，猜不中）
    if (content.includes(String(num))) return { ok: true };
    // 2xx 但没读对 → 不支持视觉（接受了请求但读不了图，或直接拒绝）
    const refused =
      VISION_UNSUPPORTED_RE.test(content) ||
      /cannot (see|read|process|view).*image|no image|unable to (see|process|view|access)/i.test(content);
    return {
      ok: false,
      unsupported: true,
      error: `${refused ? "(拒绝) " : "(未读对) "}${content.slice(0, 200)}`,
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const msg = err instanceof Error ? err.message : String(err);
    if (name === "AbortError" || name === "TimeoutError") {
      return { ok: false, unsupported: false, error: "timeout" };
    }
    return { ok: false, unsupported: false, error: msg.slice(0, 300) };
  } finally {
    clear();
  }
}

// ---------------------------------------------------------------------------
// 通道扫描与维护（单飞互斥）
// ---------------------------------------------------------------------------

interface ScanInput {
  models: Array<{
    id: string;
    provider: string;
    baseUrl: string;
    api: string;
    input: ("text" | "image")[];
    name?: string;
  }>;
  getAuth: (
    provider: string,
    modelId: string,
  ) => Promise<{ apiKey?: string; headers?: Record<string, string> } | undefined>;
  signal?: AbortSignal | null;
  onProgress?: (msg: string) => void;
}

/** 模块级扫描互斥（防定时器与手动扫描并发） */
let scanInFlight: Promise<State> | null = null;

async function scanAndMaintain(input: ScanInput): Promise<State> {
  // 单飞：已有扫描在跑则复用其 Promise
  if (scanInFlight) return scanInFlight;
  scanInFlight = (async () => {
    const prev = readState();
    const now = Date.now();
    const byKey = new Map(prev.channels.map((c) => [`${c.provider}/${c.model}`, c]));

    // 预处理：过滤出需要实测的模型（跳过 embedding、缓存未过期、baseUrl 空）
    interface PendingModel {
      m: ScanInput["models"][number];
      cached?: VisionChannel;
    }
    const pending: PendingModel[] = [];
    const staticResults: VisionChannel[] = [];

    for (const m of input.models) {
      const key = `${m.provider}/${m.id}`;
      const cached = byKey.get(key);
      const idLower = m.id.toLowerCase();

      if (idLower.includes("embedding") || idLower.includes("embed")) {
        staticResults.push({ provider: m.provider, model: m.id, baseUrl: m.baseUrl, api: m.api, vision: false });
        continue;
      }
      if (!m.baseUrl) {
        staticResults.push({
          provider: m.provider, model: m.id, baseUrl: m.baseUrl, api: m.api,
          vision: false, channelError: true, lastTested: now,
          lastError: "baseUrl 为空，跳过测试",
        });
        continue;
      }
      if (cached && cached.lastTested && now - cached.lastTested < CACHE_MAX_AGE_MS) {
        // 防御未来时间戳
        if (cached.lastTested <= now + 5 * 60 * 1000) {
          staticResults.push(cached);
          continue;
        }
      }
      pending.push({ m, cached });
    }

    // 分批并发实测（4 并发，避免同时打爆网关）
    const CONCURRENCY = 4;
    const dynamicResults: VisionChannel[] = new Array(pending.length);
    let tested = 0;
    let nextIdx = 0;

    async function worker() {
      while (true) {
        const idx = nextIdx++;
        if (idx >= pending.length) return;
        const { m } = pending[idx];
        input.onProgress?.(`[vision-router] 测试模型 ${m.provider}/${m.id} 的视觉能力…`);
        try {
          const auth = await input.getAuth(m.provider, m.id);
          const res = await testModelVision(
            { id: m.id, baseUrl: m.baseUrl },
            auth?.apiKey,
            auth?.headers,
            input.signal,
          );
          tested++;
          dynamicResults[idx] = {
            provider: m.provider,
            model: m.id,
            baseUrl: m.baseUrl,
            api: m.api,
            vision: res.ok,
            visionUnsupported: res.unsupported,
            channelError: !res.ok && !res.unsupported,
            lastTested: now,
            lastError: res.ok ? undefined : res.error,
          };
        } catch (err) {
          // 单模型失败不拖垮整轮扫描：标通道异常，继续下一个
          tested++;
          const msg = err instanceof Error ? err.message : String(err);
          input.onProgress?.(`[vision-router] ${m.provider}/${m.id} 测试异常：${msg.slice(0, 120)}`);
          dynamicResults[idx] = {
            provider: m.provider,
            model: m.id,
            baseUrl: m.baseUrl,
            api: m.api,
            vision: false,
            channelError: true,
            lastTested: now,
            lastError: msg.slice(0, 300),
          };
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, pending.length) }, () => worker()),
    );

    const results = [...staticResults, ...dynamicResults];
    const state: State = { channels: results, updatedAt: now };
    writeState(state);
    input.onProgress?.(
      `[vision-router] 扫描完成：${results.length} 个模型，${results.filter((c) => c.vision).length} 个支持视觉（本轮实测 ${tested}/${pending.length}）`,
    );
    return state;
  })().finally(() => {
    scanInFlight = null;
  });
  return scanInFlight;
}

// ---------------------------------------------------------------------------
// 兜底：外部免费通道
// ---------------------------------------------------------------------------

async function analyzeViaExternalFree(
  imagePath: string,
  prompt: string,
  signal?: AbortSignal | null,
): Promise<{ text: string; channel: string }> {
  const channels: Array<{ name: string; baseUrl: string; model: string; key?: string }> = [
    {
      name: "glm-free",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      model: "glm-4v-flash",
      key: process.env.GLM_API_KEY,
    },
    {
      name: "agnes-free",
      baseUrl: process.env.AGNES_BASE_URL ?? "https://api.agnes-ai.cn/v1/chat/completions",
      model: "agnes-2.5-flash",
      key: process.env.AGNES_API_KEY,
    },
  ].filter((c) => c.key);

  if (channels.length === 0) {
    throw new Error("未配置外部免费通道（设置 GLM_API_KEY 或 AGNES_API_KEY 可启用兜底）");
  }

  const dataUrl = encodeImageDataUrl(imagePath);
  const errors: string[] = [];
  for (const ch of channels) {
    const { signal: combined, clear } = withTimeout(signal, ROUTE_TIMEOUT_MS);
    try {
      const payload = {
        model: ch.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: dataUrl } },
              { type: "text", text: prompt },
            ],
          },
        ],
      };
      const resp = await fetch(ch.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ch.key}`,
        },
        body: JSON.stringify(payload),
        signal: combined,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error("empty response");
      return { text: content, channel: ch.name };
    } catch (err) {
      errors.push(`${ch.name}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clear();
    }
  }
  throw new Error(errors.join("; "));
}

// ---------------------------------------------------------------------------
// 识图路由核心
// ---------------------------------------------------------------------------

type RegistryLike = {
  find(provider: string, modelId: string): unknown;
  getApiKeyAndHeaders(model: unknown): Promise<
    | { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }
    | { ok: false; error: string }
  >;
};

/** 获取某个 provider/model 的模型对象 + 凭证 */
async function getModelAuth(
  registry: RegistryLike,
  provider: string,
  modelId: string,
  baseUrl: string,
) {
  let model = registry.find(provider, modelId) as
    | { id: string; baseUrl: string; api: string }
    | undefined;
  if (!model) {
    model = { id: modelId, baseUrl, api: "openai-completions" };
  }
  const auth = await registry.getApiKeyAndHeaders(model);
  return { model, auth };
}

async function analyzeImage(
  imagePath: string,
  prompt: string,
  ctx: {
    modelRegistry: RegistryLike;
    signal?: AbortSignal | null;
    model?: { provider: string; id: string } | undefined;
  },
): Promise<{ text: string; channel: string }> {
  const state = readState();
  const visionChannels = state.channels.filter((c) => c.vision);

  // 尝试列表（按 provider/model 去重）：同 provider 优先，其余依次
  const ordered: VisionChannel[] = [];
  const seen = new Set<string>();
  const current = ctx.model;
  if (current) {
    for (const c of visionChannels) {
      if (c.provider === current.provider && !seen.has(`${c.provider}/${c.model}`)) {
        ordered.push(c);
        seen.add(`${c.provider}/${c.model}`);
      }
    }
  }
  for (const c of visionChannels) {
    if (!seen.has(`${c.provider}/${c.model}`)) {
      ordered.push(c);
      seen.add(`${c.provider}/${c.model}`);
    }
  }

  if (ordered.length === 0) {
    throw new Error(
      "无可用的视觉通道（可设置 GLM_API_KEY 或 AGNES_API_KEY 启用外部免费兜底）",
    );
  }

  // 图片编码只做一次，所有通道复用
  const dataUrl = encodeImageDataUrl(imagePath);

  const errors: string[] = [];

  /** 单通道请求（返回内容字符串；失败返回 null） */
  async function tryChannel(ch: VisionChannel): Promise<string | null> {
    const { signal: combined, clear } = withTimeout(ctx.signal, ROUTE_TIMEOUT_MS);
    try {
      const { model, auth } = await getModelAuth(ctx.modelRegistry, ch.provider, ch.model, ch.baseUrl);
      if (!auth.ok) {
        errors.push(`${ch.provider}/${ch.model}: 无凭证`);
        return null;
      }
      const baseUrl = (model as { baseUrl: string }).baseUrl || ch.baseUrl;
      const payload = {
        model: ch.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: dataUrl } },
              { type: "text", text: prompt },
            ],
          },
        ],
      };
      const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(auth.headers ?? {}),
          ...(auth.apiKey ? { Authorization: `Bearer ${auth.apiKey}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: combined,
      });
      if (!resp.ok) {
        errors.push(`${ch.provider}/${ch.model}: HTTP ${resp.status}`);
        return null;
      }
      const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content;
      if (content) return content;
      errors.push(`${ch.provider}/${ch.model}: 空响应`);
      return null;
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      errors.push(
        `${ch.provider}/${ch.model}: ${name === "AbortError" ? "超时" : err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      clear();
    }
  }

  // 竞速模式：分批并发（首批 3 个同时发，谁先成功用谁；失败再补下一批）
  const RACE_BATCH = 3;
  for (let i = 0; i < ordered.length; i += RACE_BATCH) {
    const batch = ordered.slice(i, i + RACE_BATCH);
    const results = await Promise.all(batch.map((ch) => tryChannel(ch)));
    const winnerIdx = results.findIndex((r) => r !== null);
    if (winnerIdx >= 0) {
      return {
        text: results[winnerIdx]!,
        channel: `${batch[winnerIdx].provider}/${batch[winnerIdx].model}`,
      };
    }
  }

  // 外部免费兜底
  try {
    return await analyzeViaExternalFree(imagePath, prompt, ctx.signal);
  } catch (err) {
    throw new Error(
      `所有视觉通道均失败（${errors.join("; ")}；免费通道: ${err instanceof Error ? err.message : String(err)}）`,
    );
  }
}

// ---------------------------------------------------------------------------
// 扩展主入口
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let scanTimer: ReturnType<typeof setInterval> | undefined;
  let lazyScanTimer: ReturnType<typeof setTimeout> | undefined;
  let lastScanAt = 0;

  function collectModels(ctx: { modelRegistry: { getAvailable(): unknown[] } }) {
    const reg = ctx.modelRegistry as unknown as {
      getAvailable(): Array<{
        id: string;
        provider: string;
        baseUrl: string;
        api: string;
        input?: ("text" | "image")[];
        name?: string;
      }>;
    };
    return reg.getAvailable().map((m) => ({
      id: m.id,
      provider: m.provider,
      baseUrl: m.baseUrl,
      api: m.api,
      input: m.input ?? (["text"] as ("text" | "image")[]),
      name: m.name,
    }));
  }

  async function doScan(
    ctx: { modelRegistry: { getAvailable(): unknown[] }; signal?: AbortSignal | null; ui: { notify(msg: string, level: string): void } },
    opts: { silent?: boolean } = {},
  ) {
    const models = collectModels(ctx);
    if (models.length === 0) return;
    // 60s 去重
    if (Date.now() - lastScanAt < 60_000 && readState().updatedAt > 0) return;
    lastScanAt = Date.now();
    const notify = (msg: string) => {
      if (!opts.silent) ctx.ui.notify(msg, "info");
    };
    try {
      await scanAndMaintain({
        models,
        getAuth: async (provider, modelId) => {
          const m = models.find((x) => x.provider === provider && x.id === modelId);
          if (!m) return undefined;
          const registry = ctx.modelRegistry as unknown as RegistryLike;
          const { auth } = await getModelAuth(registry, provider, modelId, m.baseUrl);
          return auth.ok ? { apiKey: auth.apiKey, headers: auth.headers } : undefined;
        },
        signal: ctx.signal,
        onProgress: notify,
      });
    } catch (err) {
      console.error(`[vision-router] 扫描失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ------------------------------------------------------------------
  // session_start：加载状态 + 启动后台定时维护 + 首次惰性扫描
  // ------------------------------------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    const state = readState();
    ctx.ui.notify(
      `[vision-router] 已加载 ${state.channels.length} 个模型通道（${state.channels.filter((c) => c.vision).length} 个支持视觉）`,
      "info",
    );

    // 清理旧定时器（防 /reload 后重复）
    if (scanTimer) clearInterval(scanTimer);
    if (lazyScanTimer) clearTimeout(lazyScanTimer);
    scanTimer = undefined;
    lazyScanTimer = undefined;

    // 后台定时刷新（不阻塞会话）
    scanTimer = setInterval(() => {
      void doScan(ctx, { silent: true });
    }, REFRESH_INTERVAL_MS);

    // 首次惰性扫描（后台，不阻塞）
    lazyScanTimer = setTimeout(() => {
      void doScan(ctx, { silent: true });
    }, 5_000);
  });

  pi.on("session_shutdown", () => {
    if (scanTimer) {
      clearInterval(scanTimer);
      scanTimer = undefined;
    }
    if (lazyScanTimer) {
      clearTimeout(lazyScanTimer);
      lazyScanTimer = undefined;
    }
  });

  // ------------------------------------------------------------------
  // 核心钩子：read 图片时检测主模型看不到图 → 走视觉通道路由
  // ------------------------------------------------------------------
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "read") return;
    const path = (event.input as { path?: string }).path;
    if (!path || !isImagePath(path)) return;

    const textPart = (event.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => (c as { text?: string }).text ?? "")
      .join("\n");
    const noVision = NON_VISION_KEYWORDS.some((kw) => textPart.includes(kw));
    if (!noVision) return; // 主模型能看图，不动

    const prompt = "请详细描述这张图片的内容。";
    try {
      const { text, channel } = await analyzeImage(path, prompt, ctx);
      return {
        content: [
          {
            type: "text",
            text: `[vision-router] 主模型不支持视觉，已通过 ${channel} 通道识别：\n\n${text}`,
          },
        ],
        details: { fallback: true, channel, imagePath: path },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 保留原始信息 + 路由错误，避免丢失根因
      return {
        content: [
          {
            type: "text",
            text: `[vision-router] 视觉路由失败：${msg}\n\n（原始提示：${textPart.trim()}）`,
          },
        ],
        details: { fallbackError: msg, imagePath: path, originalNote: textPart.trim() },
      };
    }
  });

  // ------------------------------------------------------------------
  // /vision-status — 查看通道维护状态
  // ------------------------------------------------------------------
  pi.registerCommand("vision-status", {
    description: "查看视觉通道维护状态（哪些模型支持识图）",
    handler: async (_args, ctx) => {
      const state = readState();
      const lines = state.channels.map((c) => {
        if (c.vision) return `✓ ${c.provider}/${c.model}`;
        if (c.visionUnsupported) return `✗ ${c.provider}/${c.model}（不支持视觉）`;
        if (c.channelError) return `? ${c.provider}/${c.model}（通道异常: ${c.lastError ?? ""}）`;
        return `✗ ${c.provider}/${c.model}`;
      });
      ctx.ui.notify(
        lines.length
          ? `视觉通道（${state.channels.filter((c) => c.vision).length}/${state.channels.length} 可用）：\n${lines.join("\n")}`
          : "尚无通道数据，运行 /vision-scan 开始扫描。",
        "info",
      );
    },
  });

  // ------------------------------------------------------------------
  // /vision-scan — 手动触发扫描
  // ------------------------------------------------------------------
  pi.registerCommand("vision-scan", {
    description: "立即扫描并实测所有模型的视觉能力",
    handler: async (_args, ctx) => {
      ctx.ui.notify("开始扫描模型视觉能力…", "info");
      await doScan(ctx, { silent: false });
      ctx.ui.notify("扫描完成！运行 /vision-status 查看结果", "info");
    },
  });

  // ------------------------------------------------------------------
  // /vision-test — 手动测试一张图
  // ------------------------------------------------------------------
  pi.registerCommand("vision-test", {
    description: "用当前视觉通道测试一张图片（用法：/vision-test <图片路径>）",
    handler: async (args, ctx) => {
      const imagePath = args.trim().replace(/^["']|["']$/g, "");
      if (!imagePath) {
        ctx.ui.notify("用法：/vision-test <图片路径>", "warning");
        return;
      }
      const resolved = isAbsolute(imagePath)
        ? imagePath
        : join(ctx.cwd, imagePath);
      if (!isImagePath(resolved)) {
        ctx.ui.notify("不是支持的图片格式（jpg/png/webp/gif/bmp）", "warning");
        return;
      }
      ctx.ui.notify("正在识别…", "info");
      try {
        const { text, channel } = await analyzeImage(resolved, "请详细描述这张图片的内容。", ctx);
        ctx.ui.notify(`[${channel}] 识别完成`, "info");
        ctx.ui.setEditorText(`【${channel} 识别结果】\n\n${text}`);
      } catch (err) {
        ctx.ui.notify(`识别失败：${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  // ------------------------------------------------------------------
  // vision_analyze 工具（模型可直接调用）
  // ------------------------------------------------------------------
  pi.registerTool({
    name: "vision_analyze",
    label: "Vision Analyze",
    description:
      "Analyze an image file using the best available vision channel (auto-maintained model list, falls back to free GLM/Agnes). Use when the current model cannot see images.",
    promptSnippet: "Analyze image files via auto-maintained vision channels",
    parameters: Type.Object({
      imagePath: Type.String({ description: "Path to the image file" }),
      prompt: Type.Optional(Type.String({ description: "Optional custom prompt" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const resolved = isAbsolute(params.imagePath)
        ? params.imagePath
        : join(ctx.cwd, params.imagePath);
      // 仅允许图片文件，避免把任意文件内容发到外部兜底端点
      if (!isImagePath(resolved)) {
        throw new Error("仅支持图片文件（jpg/png/webp/gif/bmp）");
      }
      // 失败用 throw 让 pi 正确标记 isError
      const { text, channel } = await analyzeImage(
        resolved,
        params.prompt ?? "请详细描述这张图片的内容。",
        { modelRegistry: ctx.modelRegistry as unknown as RegistryLike, signal, model: ctx.model as unknown as { provider: string; id: string } | undefined },
      );
      return {
        content: [{ type: "text", text }],
        details: { channel, imagePath: resolved },
      };
    },
  });
}
