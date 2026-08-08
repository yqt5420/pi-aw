/**
 * Token Speed Extension
 *
 * Displays real-time token generation speed (tokens/sec) in the footer
 * while the LLM is streaming a response.
 *
 * - Shows live speed during streaming (⚡ 12.5 t/s)
 * - Shows final summary on completion (✓ 512 tok @ 15.3 t/s (33.5s))
 * - Auto-clears after 5 minutes
 *
 * Subagent support (v1.1.0):
 * While a blocking subagent tool (`subagent` / `subagent_consult` from
 * @narumitw/pi-subagents) is running, the footer shows the subagent's
 * token speed (⚡ 子代理 [worker] 1.2k tok @ 15.2 t/s | 首 1.2s), derived
 * from `tool_execution_update` events — pi-subagents forwards one update
 * per assistant message end of the child process, carrying exact usage
 * (output tokens) plus messages for char-based estimation.
 * The main agent's own streaming display is paused while a subagent runs.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SUBAGENT_TOOLS = new Set(["subagent", "subagent_consult"]);
/** 非 CJK 字符≈token 估算：英文约 4 字符/token */
const APPROX_CHARS_PER_TOKEN = 4;
/** CJK 字符范围：基本区 + 扩展 A + 兼容表意 */
const CJK_CODEPOINT_RANGES: Array<[number, number]> = [
	[0x3400, 0x4dbf],
	[0x4e00, 0x9fff],
	[0xf900, 0xfaff],
];
/** 统计字符串中的 CJK（中文/日韩汉字）字符数。一个汉字通常≈1 token，不能套用 /4。 */
function countCJK(s: string): number {
	let n = 0;
	for (const ch of s) {
		const c = ch.codePointAt(0)!;
		for (const [lo, hi] of CJK_CODEPOINT_RANGES) {
			if (c >= lo && c <= hi) {
				n++;
				break;
			}
		}
	}
	return n;
}
/** 主 agent 实时速度刷新周期（ms）。有 delta 时即时刷新，此为主 agent
 * 无新 token 时的兜底心跳（覆盖 thinking 停顿期），避免空转。 */
const MAIN_HEARTBEAT_MS = 200;
/** 子代理心率刷新周期（ms） */
const SUB_HEARTBEAT_MS = 150;
/** delta 即时刷新的最小节流间隔（ms）：防止 token 极密时过度刷新 */
const DELTA_THROTTLE_MS = 50;
/** 防零除/初始缓冲的最短耗时（s），低于此显示 ... */
const MIN_SPEED_ELAPSED_S = 0.05;
/** 汇总展示后自动清除的时长（5 分钟） */
const CLEAR_AFTER_MS = 5 * 60 * 1000;

export default function (pi: ExtensionAPI) {
	// 主 agent 流式显示状态
	let enabled = true;
	let startTime = 0;
	let firstTokenTime = 0;
	let hasFirstToken = false;
	let charCount = 0;
	let thinkingCharCount = 0;
	let toolCallCharCount = 0;
	let cjkCharCount = 0;
	let lastDeltaRefresh = 0;
	let preciseOutput = 0;
	let hasPrecise = false;
	let isStreaming = false;
	let timer: ReturnType<typeof setInterval> | null = null;
	let clearTimer: ReturnType<typeof setTimeout> | null = null;
	let latestCtx: ExtensionContext | null = null;

	// 会话级缓存命中率累积（跨轮跨子代理，仅在有缓存数据时才展示）
	let sessionCacheRead = 0;
	let sessionInput = 0;

	// 子代理显示状态
	let subActive = false;
	let subStartTime = 0;
	let subFirstUpdateMs = 0;
	let subHasFirstUpdate = false;
	let subStats: SubStats = emptyStats();
	let subTimer: ReturnType<typeof setInterval> | null = null;
	let subClearTimer: ReturnType<typeof setTimeout> | null = null;
	let subLatestCtx: ExtensionContext | null = null;

	function getElapsedSec(): number {
		return (Date.now() - startTime) / 1000;
	}

	function getApproxTokens(): number {
		const totalChars = charCount + thinkingCharCount + toolCallCharCount;
		// CJK 字符按 1 字≈1 token，其余按 /4 估算
		return Math.round(cjkCharCount + (totalChars - cjkCharCount) / APPROX_CHARS_PER_TOKEN);
	}

	function getSpeedStr(approxTokens: number): string {
		if (!isStreaming || approxTokens === 0) return "0 t/s";
		const elapsed = getElapsedSec();
		if (elapsed < MIN_SPEED_ELAPSED_S) return "...";
		return `${(approxTokens / elapsed).toFixed(1)} t/s`;
	}

	function fmtTokens(n: number): string {
		if (!Number.isFinite(n) || n <= 0) return "0";
		if (n < 1000) return `${n}`;
		if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
		return `${Math.round(n / 1000)}k`;
	}

	function fmtTTFB(): string {
		return hasFirstToken ? `${(firstTokenTime / 1000).toFixed(1)}s` : "...";
	}

	/** 会话级缓存读取命中率后缀。无缓存数据时返回空串（不展示）。 */
	function cacheHitSuffix(): string {
		const total = sessionCacheRead + sessionInput;
		if (sessionCacheRead <= 0 || total <= 0) return "";
		const pct = Math.round((sessionCacheRead / total) * 100);
		return ` | 缓${pct}%`;
	}

	function buildLabel(
		tokenCount: number,
		elapsedSec: number,
		prefix: string,
	): string {
		const speed = tokenCount > 0 ? (elapsedSec < MIN_SPEED_ELAPSED_S ? "..." : (tokenCount / elapsedSec).toFixed(1)) : "0";
		const ttfb = hasFirstToken
			? ` | 首 ${(firstTokenTime / 1000).toFixed(1)}s`
			: "";
		return `${prefix} ${fmtTokens(tokenCount)} tok @ ${speed} t/s (${elapsedSec.toFixed(1)}s)${ttfb}${cacheHitSuffix()}`;
	}

	function updateStatus() {
		if (!isStreaming || !latestCtx || !enabled) return;
		// 子代理运行期间暂停主 agent 刷新，避免覆盖子代理速度显示
		if (subActive) return;
		const theme = latestCtx.ui.theme;
		const approxTokens = getApproxTokens();
		latestCtx.ui.setStatus(
			"token-speed",
			theme.fg(
				"accent",
				`⚡ ${fmtTokens(approxTokens)} tok @ ${getSpeedStr(approxTokens)} | 首 ${fmtTTFB()}${cacheHitSuffix()}`,
			),
		);
	}

	// ---------- 子代理统计 ----------

	interface UsageLike {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		contextTokens?: number;
		turns?: number;
		cost?: number;
	}

	interface MessageLike {
		role?: string;
		content?: Array<{ type?: string; text?: string; thinking?: string }>;
	}

	interface SingleResultLike {
		agent?: string;
		exitCode?: number;
		finalOutput?: string;
		messages?: MessageLike[];
		usage?: Partial<UsageLike>;
	}

	interface SubagentDetailsLike {
		mode?: string;
		results?: SingleResultLike[];
	}

	interface SubStats {
		output: number; // 精确 output tokens 累计
		hasUsage: boolean; // 是否拿到过非零精确值
		chars: number; // assistant 消息字符数（估算兜底）
		cjk: number; // 其中 CJK 字符数（估算更准）
		agents: string[];
	}

	function emptyStats(): SubStats {
		return { output: 0, hasUsage: false, chars: 0, cjk: 0, agents: [] };
	}

	/** 从 partialResult.details.results 汇总 token 统计 */
	function collectStats(details: SubagentDetailsLike | undefined): SubStats {
		const stats = emptyStats();
		for (const result of details?.results ?? []) {
			if (typeof result.agent === "string" && result.agent && !stats.agents.includes(result.agent)) {
				stats.agents.push(result.agent);
			}
			const usage = result.usage;
			if (usage && typeof usage.output === "number" && usage.output > 0) {
				stats.output += usage.output;
				stats.hasUsage = true;
			}
			for (const message of result.messages ?? []) {
				if (message.role !== "assistant") continue;
				for (const part of message.content ?? []) {
					if (typeof part.text === "string") {
						stats.chars += part.text.length;
						stats.cjk += countCJK(part.text);
					}
					if (typeof part.thinking === "string") {
						stats.chars += part.thinking.length;
						stats.cjk += countCJK(part.thinking);
					}
				}
			}
		}
		return stats;
	}

	/** 流式中优先精确值，兜底字符估算 */
	function getSubTokenCount(stats: SubStats): { count: number; precise: boolean } {
		if (stats.hasUsage) return { count: stats.output, precise: true };
		return { count: Math.round(stats.cjk + (stats.chars - stats.cjk) / APPROX_CHARS_PER_TOKEN), precise: false };
	}

	function subGetElapsedSec(): number {
		return (Date.now() - subStartTime) / 1000;
	}

	function subGetSpeedStr(count: number): string {
		if (!subActive || count === 0) return "0 t/s";
		const elapsed = subGetElapsedSec();
		if (elapsed < MIN_SPEED_ELAPSED_S) return "...";
		return `${(count / elapsed).toFixed(1)} t/s`;
	}

	function subAgentLabel(agents: string[]): string {
		if (agents.length === 0) return "";
		if (agents.length === 1) return ` [${agents[0]}]`;
		return ` [${agents.join("+")}]`;
	}

	/** 从工具 args 中提取 agent 名（single/parallel/chain/consult 各模式） */
	function extractAgentNames(args: unknown): string[] {
		const names: string[] = [];
		if (!args || typeof args !== "object") return names;
		const record = args as Record<string, unknown>;
		const push = (name: unknown) => {
			if (typeof name === "string" && name && !names.includes(name)) names.push(name);
		};
		push(record.agent);
		for (const key of ["tasks", "chain"]) {
			if (!Array.isArray(record[key])) continue;
			for (const item of record[key]) {
				if (item && typeof item === "object") push((item as Record<string, unknown>).agent);
			}
		}
		return names;
	}

	function subUpdateStreaming(ctx: ExtensionContext) {
		const theme = ctx.ui.theme;
		const { count } = getSubTokenCount(subStats);
		ctx.ui.setStatus(
			"token-speed",
			theme.fg(
				"accent",
				`⚡ 子代理${subAgentLabel(subStats.agents)} ${fmtTokens(count)} tok @ ${subGetSpeedStr(count)} | 首 ${subHasFirstUpdate ? `${(subFirstUpdateMs / 1000).toFixed(1)}s` : "..."}`,
			),
		);
	}

	function subStopStreaming() {
		subActive = false;
		if (subTimer) {
			clearInterval(subTimer);
			subTimer = null;
		}
	}

	// ---------- 命令 ----------

	pi.registerCommand("tokenspeed", {
		description: "Toggle token speed display on/off",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled) {
				ctx.ui.notify("Token speed display enabled", "info");
			} else {
				ctx.ui.setStatus("token-speed", undefined);
				ctx.ui.notify("Token speed display disabled", "info");
			}
		},
	});

	// ---------- 生命周期 ----------

	// 清理 timer 和 clearTimer，防止退出时残留
	pi.on("session_shutdown", async () => {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		if (clearTimer) {
			clearTimeout(clearTimer);
			clearTimer = null;
		}
		if (subTimer) {
			clearInterval(subTimer);
			subTimer = null;
		}
		if (subClearTimer) {
			clearTimeout(subClearTimer);
			subClearTimer = null;
		}

		// 重置子代理状态，避免上一个被中止（end 被跳过）的残留跨会话带入
		subActive = false;
		subLatestCtx = null;
		// 重置主 agent 流式/精确标记，避免进程级状态跨会话波出
		isStreaming = false;
		hasPrecise = false;
		preciseOutput = 0;
		// 重置会话级缓存累积，避免跨会话带入
		sessionCacheRead = 0;
		sessionInput = 0;
	});

	pi.on("turn_start", async (_event, ctx) => {
		// 取消上一轮的清除定时器，避免误清本轮状态
		if (clearTimer) {
			clearTimeout(clearTimer);
			clearTimer = null;
		}

		startTime = Date.now();
		firstTokenTime = 0;
		hasFirstToken = false;
		charCount = 0;
		thinkingCharCount = 0;
		toolCallCharCount = 0;
		cjkCharCount = 0;
		lastDeltaRefresh = 0;
		hasPrecise = false;
		preciseOutput = 0;
		isStreaming = true;
		latestCtx = ctx;

		if (!enabled) return;

		// 防御：若上一轮异常未清掉 timer，先清再建，避免句柄泄漏
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		timer = setInterval(() => updateStatus(), MAIN_HEARTBEAT_MS);

		const theme = ctx.ui.theme;
		ctx.ui.setStatus("token-speed", theme.fg("accent", "⚡ ..."));
	});

	pi.on("message_end", async (event, _ctx) => {
		if (!isStreaming || !enabled) return;
		if (event.message.role !== "assistant") return;
		const usage = event.message.usage;
		if (usage?.output) {
			preciseOutput += usage.output;
			hasPrecise = true;
		}
		// 累积会话级缓存命中率数据（仅在有值时不展示）
		// 语义:每条 assistant message 的 usage 是单次 provider 请求的完整用量
		//（含完整 input/cacheRead），跨消息累加即会话真实总计费用量，命中率为
		// 全会话加权命中率;无需做增量差（若未来 usage 变增量再改为差量）。
		if (usage) {
			if (typeof usage.cacheRead === "number" && usage.cacheRead > 0) sessionCacheRead += usage.cacheRead;
			if (typeof usage.input === "number" && usage.input > 0) sessionInput += usage.input;
		}
	});

	pi.on("message_update", async (event, _ctx) => {
		if (!isStreaming || !enabled) return;
		const ev = event.assistantMessageEvent;

		// 记录首字时间（第一个 thinking_delta、text_delta 或 toolcall_delta）
		if (
			!hasFirstToken &&
			(ev.type === "text_delta" || ev.type === "thinking_delta" || ev.type === "toolcall_delta")
		) {
			firstTokenTime = Date.now() - startTime;
			hasFirstToken = true;
		}

		// Count text tokens (output content)
		if (ev.type === "text_delta") {
			charCount += ev.delta.length;
			cjkCharCount += countCJK(ev.delta);
		}

		// Count thinking tokens
		if (ev.type === "thinking_delta") {
			thinkingCharCount += ev.delta.length;
			cjkCharCount += countCJK(ev.delta);
		}

		// Count tool call tokens (e.g. file write content)
		if (ev.type === "toolcall_delta") {
			toolCallCharCount += ev.delta.length;
			cjkCharCount += countCJK(ev.delta);
		}

		// 有增量文本时立即刷新，让速度跟手（节流防过刷，避免等待心跳）
		const now = Date.now();
		if (!lastDeltaRefresh || now - lastDeltaRefresh >= DELTA_THROTTLE_MS) {
			lastDeltaRefresh = now;
			updateStatus();
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		isStreaming = false;
		if (timer) {
			clearInterval(timer);
			timer = null;
		}

		if (!enabled) {
			latestCtx = null;
			return;
		}

		const elapsedSec = getElapsedSec();
		const theme = ctx.ui.theme;

		if (hasPrecise) {
			ctx.ui.setStatus(
				"token-speed",
				theme.fg("success", buildLabel(preciseOutput, elapsedSec, "✓")),
			);
		} else {
			ctx.ui.setStatus(
				"token-speed",
				theme.fg("warning", buildLabel(getApproxTokens(), elapsedSec, "≈")),
			);
		}

		// Auto-clear after 5 minutes（用 latestCtx 避免会话切换后 ctx 失效）
		const clearCtx = latestCtx;
		clearTimer = setTimeout(() => {
			if (clearCtx) clearCtx.ui.setStatus("token-speed", undefined);
			clearTimer = null;
		}, CLEAR_AFTER_MS);

		latestCtx = null;
	});

	// ---------- 子代理工具事件 ----------

	pi.on("tool_execution_start", async (event, ctx) => {
		if (!SUBAGENT_TOOLS.has(event.toolName)) return;
		if (!enabled || !ctx.hasUI) return;

		// 取消上一轮的清除定时器
		if (subClearTimer) {
			clearTimeout(subClearTimer);
			subClearTimer = null;
		}

		subActive = true;
		subStartTime = Date.now();
		subFirstUpdateMs = 0;
		subHasFirstUpdate = false;
		subStats = emptyStats();
		subLatestCtx = ctx;

		const theme = ctx.ui.theme;
		const agents = extractAgentNames(event.args);
		ctx.ui.setStatus(
			"token-speed",
			theme.fg("accent", `⚡ 子代理${subAgentLabel(agents)} 启动中...`),
		);

		// 心跳刷新：子代理思考/工具执行期间无 message_end 时保持显示。
		// 先清旧句柄再建，避免并发/嵌套子代理或在途残留把 interval 句柄覆盖泄漏。
		if (subTimer) {
			clearInterval(subTimer);
			subTimer = null;
		}
		subTimer = setInterval(() => {
			if (!subLatestCtx || !subActive) return;
			subUpdateStreaming(subLatestCtx);
		}, SUB_HEARTBEAT_MS);
	});

	pi.on("tool_execution_update", async (event, _ctx) => {
		if (!SUBAGENT_TOOLS.has(event.toolName)) return;
		if (!enabled || !subActive || !subLatestCtx) return;

		const details = (event.partialResult as { details?: SubagentDetailsLike } | undefined)?.details;
		const stats = collectStats(details);
		if (stats.agents.length === 0 && stats.output === 0 && stats.chars === 0) return;

		if (!subHasFirstUpdate) {
			subFirstUpdateMs = Date.now() - subStartTime;
			subHasFirstUpdate = true;
		}
		subStats = stats;

		subUpdateStreaming(subLatestCtx);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (!SUBAGENT_TOOLS.has(event.toolName)) return;
		if (!enabled || !subActive) return;

		subStopStreaming();
		if (!ctx.hasUI) {
			subLatestCtx = null;
			return;
		}

		const details = (event.result as { details?: SubagentDetailsLike } | undefined)?.details;
		subStats = collectStats(details);
		// 子代理收尾时一次性累积缓存消费到会话级命中率（避免 update 多触发重复计数）
		for (const result of details?.results ?? []) {
			const usage = result.usage;
			if (!usage) continue;
			if (typeof usage.cacheRead === "number" && usage.cacheRead > 0) sessionCacheRead += usage.cacheRead;
			if (typeof usage.input === "number" && usage.input > 0) sessionInput += usage.input;
		}

		const theme = ctx.ui.theme;
		const { count, precise } = getSubTokenCount(subStats);
		const elapsedSec = subGetElapsedSec();
		const speed = elapsedSec < MIN_SPEED_ELAPSED_S ? "..." : count > 0 ? (count / elapsedSec).toFixed(1) : "0";
		const ttfb = subHasFirstUpdate
			? ` | 首 ${(subFirstUpdateMs / 1000).toFixed(1)}s`
			: "";
		const prefix = precise ? "✓" : "≈";
		const color = precise ? "success" : "warning";
		ctx.ui.setStatus(
			"token-speed",
			theme.fg(
				color,
				`${prefix} 子代理${subAgentLabel(subStats.agents)} ${fmtTokens(count)} tok @ ${speed} t/s (${elapsedSec.toFixed(1)}s)${ttfb}${cacheHitSuffix()}`,
			),
		);

		// Auto-clear after 5 minutes（用 subLatestCtx 避免会话切换后 ctx 失效）
		const clearCtx = subLatestCtx;
		subClearTimer = setTimeout(() => {
			if (clearCtx) clearCtx.ui.setStatus("token-speed", undefined);
			subClearTimer = null;
		}, CLEAR_AFTER_MS);

		subLatestCtx = null;
	});
}
