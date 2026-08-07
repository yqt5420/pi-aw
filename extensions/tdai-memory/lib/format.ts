/**
 * 召回结果格式化。
 *
 * - formatL1Memories：L1 动态记忆 → `<relevant-memories>` 块（prependContext，作为消息注入）
 * - formatSystemContext：L3 画像 + L2 场景索引 + 工具指南 → 追加到 systemPrompt
 */

import type { ScenarioEntry, SearchResultItem } from "./client.js";

/** 场景索引单条 summary 截断长度。 */
const SCENE_SUMMARY_MAX = 200;
/** L1 单条记忆截断长度。 */
const MEM_LINE_MAX = 300;
/** L1 整块（<relevant-memories>）总截断长度。 */
const MEM_TOTAL_MAX = 8000;
/** L3 画像（<tdai_profile_memory>）截断长度。 */
const PERSONA_MAX = 6000;

/** 工具指南（<tdai-memory-tools-guide> 块，追加进 systemPrompt）。 */
export const TOOLS_GUIDE = `<tdai-memory-tools-guide>
你已接入 MemoryCore 长期记忆系统（团队记忆 + 团队技能 + 对话/场景/画像记忆）。
- 记忆：多数记忆会自动注入，需要时可主动搜索/沉淀/删除。
- 技能：团队可复用的经验，可主动搜索/创建/删除。
调用原则：
- 每轮最多 3 次记忆类工具调用；结果仅供辅助回答，不要将记忆/技能内容原样回显。
- 涉及团队规范、历史经验、用户偏好时优先检索记忆，避免重复询问。
- 具体可用工具以你当前收到的工具列表为准（lite/full 模式、wiki 开关不同）。
</tdai-memory-tools-guide>`;

/** L1 原子记忆 → `<relevant-memories>` 块。空 items 返回 undefined。 */
export function formatL1Memories(items: SearchResultItem[] | undefined | null): string | undefined {
  const valid = (items ?? []).filter((item) => item && typeof item.content === "string" && item.content.trim());
  if (valid.length === 0) return undefined;
  const lines = valid.map((item) => {
    const type = item.type && item.type !== "unknown" ? item.type : "memory";
    const content = item.content.trim();
    const clipped = content.length > MEM_LINE_MAX ? `${content.slice(0, MEM_LINE_MAX)}…` : content;
    return `- [${type}] ${clipped}`;
  });
  let block = lines.join("\n");
  if (block.length > MEM_TOTAL_MAX) {
    block = `${block.slice(0, MEM_TOTAL_MAX)}\n…[召回内容已截断]`;
  }
  return `<relevant-memories>\n${block}\n</relevant-memories>`;
}

/** L2 场景索引行。 */
function formatSceneLine(entry: ScenarioEntry): string {
  const summary = (entry.summary ?? "").trim();
  const clipped = summary.length > SCENE_SUMMARY_MAX ? `${summary.slice(0, SCENE_SUMMARY_MAX)}…` : summary;
  return `- \`${entry.path}\` — ${clipped || "(无摘要)"}`;
}

export interface SystemContextResult {
  /** 追加到 systemPrompt 的上下文块（L3 + L2 + 工具指南）。 */
  systemContext?: string;
  /** L3 画像原文（供调用方缓存）。 */
  personaContent: string | null;
  /** L2 场景条目（供调用方缓存）。 */
  sceneEntries: ScenarioEntry[];
}

/**
 * 组装 systemContext：`<tdai_profile_memory>` + `<l2_scene_index>` + `<tdai-memory-tools-guide>`。
 * persona/scenes 均可为空（该部分省略）。
 */
export function formatSystemContext(
  persona: string | null | undefined,
  scenes: ScenarioEntry[] | null | undefined,
  includeToolsGuide = true,
): SystemContextResult {
  const parts: string[] = [];
  let personaContent: string | null = null;
  const sceneEntries: ScenarioEntry[] = (scenes ?? []).filter(
    (s) => s && typeof s.path === "string" && s.path.trim(),
  );

  if (persona && persona.trim()) {
    const trimmed = persona.trim();
    personaContent = trimmed.length > PERSONA_MAX ? `${trimmed.slice(0, PERSONA_MAX)}\n…[画像已截断]` : trimmed;
    parts.push(`<tdai_profile_memory>\n${personaContent}\n</tdai_profile_memory>`);
  }
  if (sceneEntries.length > 0) {
    const lines = sceneEntries.map(formatSceneLine);
    parts.push(`<l2_scene_index>\n${lines.join("\n")}\n</l2_scene_index>`);
  }
  if (includeToolsGuide) {
    parts.push(TOOLS_GUIDE);
  }

  const systemContext = parts.length > 0 ? parts.join("\n\n") : undefined;
  return { systemContext, personaContent, sceneEntries };
}
