# pi-auto-title

自动为新会话生成一句话简洁标题，告别 `/resume` 里一堆笼统的首条消息。

## 功能

- 每次**新会话**首次提交信息时，把首条消息交给一个 OpenAI 兼容 LLM 端点，生成 ≤ 20 字的一句话标题。
- 通过 `pi.setSessionName()` 写回，显示在 `/resume` 会话选择器，替代默认的首条消息预览。
- **尊重手动命名**：已 `/name` / `--name` 设置过的会话不会被覆盖。
- **防重复**：每个会话只生成一次，不会每次 turn 都重命名。
- **失败零侵入**：端点不可达 / 未配置 / 超时均静默跳过，绝不阻塞正常对话。
- **自愈重试**：网关偶发返回空内容时会内部重试（仅对快速空响应，不会拖慢 agent 启动）；生成失败采用 20s 冷却后在下轮 turn 重试，不永久放弃。

## 配置（全部可选）

**默认零配置、开箱即用**：标题生成自动**复用会话当前正在使用的模型**——`/model` 选过什么就用什么，包括它的 base URL 与 API key（通过 `ctx.model` + `ctx.modelRegistry` 解析）。

仅在需要覆盖会话默认模型，或想指定比对话模型更便宜的小模型专跑标题时，才设置环境变量（OpenAI 兼容端点 `POST {base}/chat/completions`，Anthropic 模型自动走 `/messages`）：

| 变量 | 必填 | 说明 |
|------|:--:|------|
| `AUTO_TITLE_BASE` | 否 | LLM 网关 base URL。未设时复用会话当前模型的 `baseUrl`，再回退 `NEWAPI_BASE_URL` |
| `AUTO_TITLE_API_KEY` | 否 | API Key。未设时复用会话当前模型的凭据，再回退 `NEWAPI_API_KEY` |
| `AUTO_TITLE_MODEL` | 否 | 生成标题用的模型 id。未设时用会话当前模型（建议想省开销时设便宜小模型，如 `qwen-turbo` / `deepseek-chat`） |
| `AUTO_TITLE_MAX` | 否 | 标题最大字符数，默认 `20`，范围 10–40 |

想用独立于会话的便宜小模型跑标题，才需要配置：

```bash
export AUTO_TITLE_MODEL=deepseek-chat    # 可选：覆盖会话模型
```

> 什么都不配也没关系——直接跟随当前会话模型，不打扰现有使用。

## 生效方式

本插件随 pi-aw 整包一起安装（见上层总 README）。单独调试可用：

```bash
pi -e extensions/pi-auto-title/extensions/index.ts
```

## 注意

- 每次新会话首次提交会多调用一次 LLM 生成标题，属于正常开销；用便宜模型可忽略。
- 生成质量取决于首条消息是否表达清晰；标题仅作会话选择器预览，不影响对话内容。