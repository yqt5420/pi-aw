# tdai-memory

**pi coding agent 的 MemoryCore 长期记忆扩展**——直连自建 [TencentDB Agent Memory](https://github.com/TencentCloud/tencentdb-agent-memory)（Memory Hub）服务端 HTTP API。

- L0 对话 / L1 原子记忆 / L2 场景 / L3 核心画像，分层自动沉淀与召回
- 团队技能库：搜索、创建、删除、提炼
- 知识库（wiki）：搜索/页面读写/素材加工（实验性，需开启）
- 全部 29 个 `tdai_*` 工具按 **lite / full** 两档可控注册，控制每轮 token 开销

---

## 📦 安装

随 `pi-aw` 仓库一起，一行装整套：

```bash
pi install git:github.com/yqt5420/pi-aw@main
```

> 首次需要配置并 `/reload`，插件才会注册工具。详见下文「配置」。

---

## 🧠 能力总览

记忆系统是**分层自动闭环**的：

| 环节 | 是否自动 | 说明 |
|------|:--:|------|
| 对话写 L0 | ✅ 自动 | 每轮 `agent_end` 写原始对话 |
| L1/L2/L3 提炼 | ✅ 自动 | 服务端 pipeline 从 L0 提炼（需服务端配好可 function-calling 的模型）|
| 召回注入 | ✅ 自动 | `before_agent_start` 注入 `<relevant-memories>` + 画像 + 场景索引 |
| 主动检索 / 沉淀 | 工具 | 见下方工具清单 |

### 工具清单（29 个）

**lite 核心集（14 个，默认）—— 团队记忆 + 团队技能的创建/删除/搜索/读取：**

| 分类 | 工具 |
|------|------|
| 记忆·搜索/读 | `tdai_memory_search` `tdai_conversation_search` `tdai_read_scene` `tdai_atomic_query` |
| 记忆·写 | `tdai_core_write`（L3 画像）`tdai_scenario_write`（L2 场景）`tdai_scenario_remove` |
| 记忆·更新/删 | `tdai_atomic_update` `tdai_atomic_delete` |
| 技能·读/搜 | `tdai_skill_search` `tdai_skill_view` |
| 技能·建/删/提炼 | `tdai_skill_create` `tdai_skill_delete` `tdai_skill_extract` |

**full 追加（15 个）—— 技能全面管理 + 知识库 wiki + 记忆深度管理：**
`tdai_skill_list/update/patch/versions/files_read/files_write/files_remove/conversation_add` · `tdai_wiki_search/page_read/page_write/list/create/delete/ingest`

> 记忆的「创建」主要靠 L0 对话自动沉淀（服务端 `atomic/update`、`scenario/write` **仅更新已有、无 upsert**），工具围绕「更新 + 删除 + 搜索」设计。

### 命令

| 命令 | 作用 |
|------|------|
| `/tdai-setup` | 交互式配置 endpoint/apiKey/teamId/userId/gatewayToken 并测试连接 |
| `/tdai-tools` | 切换工具模式 lite ↔ full（写配置，需 `/reload` 生效）|
| `/reload` | 让 pi 重新加载插件使改动生效 |

---

## ⚙️ 配置

### 1. 全局配置（推荐，密钥放这里）

文件：`~/.pi/agent/extensions/tdai-memory/config.json`（从 `config.example.json` 复制改）

```json
{
  "endpoint": "https://mem.example.com",
  "apiKey": "sk-mem-…",
  "gatewayToken": "…",
  "serviceId": "default",
  "teamId": "team-…",
  "userId": "usr-…",
  "fixedAgentId": "agt-…",
  "projectAgent": false,
  "recall": { "maxResults": 5, "includePersona": true, "includeSceneNav": true },
  "capture": { "enabled": true },
  "wiki": { "enabled": false },
  "tools": { "mode": "lite" }
}
```

| 字段 | 说明 |
|------|------|
| `endpoint` | MemoryCore 服务端地址（core 数据层）|
| `apiKey` / `gatewayToken` | 鉴权。配了 `gatewayToken` 则走网关统一路由；wiki 等走 `hub` 端口或网关 |
| `serviceId` / `teamId` / `userId` / `fixedAgentId` | 三元组隔离 + 固定 agent 标识 |
| `projectAgent` | 按 cwd 维护独立项目级 agent（防跨项目串台）|
| `recall` | 召回条数 / 是否注入画像 / 场景导航 |
| `capture.enabled` | 是否自动捕获对话写 L0 |
| `wiki.enabled` | 是否注册 wiki 工具（实验性，需服务端 hub 层可用）|
| `tools.mode` | `lite`（14 工具，默认）/ `full`（29 工具）|

> ⚠️ 本文件含密钥，**不进 git**。

### 2. 环境变量（覆盖 config.json，优先级最高）

| 变量 | 作用 |
|------|------|
| `TDAI_MEMORY_ENDPOINT` / `TDAI_MEMORY_API_KEY` / `TDAI_MEMORY_GATEWAY_TOKEN` | endpoint / 密钥 |
| `TDAI_MEMORY_TEAM_ID` / `TDAI_MEMORY_USER_ID` / `TDAI_MEMORY_AGENT_ID` | 三元组 |
| `TDAI_CAPTURE` / `TDAI_WIKI` / `TDAI_PROJECT_AGENT` | 开关（`true/false`）|
| `TDAI_RECALL_MAX_RESULTS` / `TDAI_RECALL_PERSONA` / `TDAI_RECALL_SCENE` | 召回参数 |
| `TDAI_TOOLS_MODE` | `lite` / `full` |

### 3. 项目级配置（某项目独有）

`{项目根}/.pi/tdai-memory.json`，只对该项目生效，可提交共享或本机独占。

---

## 🧰 常用操作示例

```text
# 搜某条记忆
tdai_memory_search  query="老板对模型选型的偏好" type="preference"

# 主动把结论沉淀成 L3 画像 / L2 场景
tdai_core_write       content="团队记忆抽取模型固定用 DeepSeek-V4-Pro……"
tdai_scenario_write   path="work/2025-q3/tdai-plugin" content="……"

# 团队技能：创建 / 删除 / 提炼
tdai_skill_create  name="deploy-sop" content="---\nname: deploy-sop\ndescription: 部署 SOP\n---\n……"
tdai_skill_delete  skill_id="skl-xxx"

# 删一条错误记忆
tdai_atomic_delete  ids=["m_xxx"]
```

> 技能 frontmatter 必须含 `name` 和 `description` 两个字段，否则创建失败。

---

## 🛠 服务端配合要点（如需自建）

核心提取模型需**支持稳定的 function-calling**（L2/L3 生成链路依赖工具调用）：
- LLM 选型：优先 `DeepSeek-V4-Pro` / `GLM-5.2`（`DeepSeek-V4-Flash` 会返回空 tool-call 导致 L2/L3 不生成）
- 服务端配置 `tdai-gateway.yaml`：`memory.promptMode` 用 `code`（代码/排障场景抽取效果好）、`memory.extraction.model` 单独指定提取模型
- 需开启 hook 让 `conversation/add` 写 L0；wiki 需 hub(8424) 端口通过反代暴露

---

## 📁 目录结构

```
extensions/tdai-memory/
├── index.ts          # 插件主入口（29 工具 + hooks + 命令）
├── config.example.json
├── lib/
│   ├── client.ts     # MemoryClient HTTP 客户端
│   ├── recall.ts     # before_agent_start 召回注入
│   ├── capture.ts    # agent_end L0 捕获
│   ├── sanitize.ts   # 文本清洗（防注入污染回流）
│   └── format.ts     # 召回/画像格式化 + TOOLS_GUIDE
└── README.md
```