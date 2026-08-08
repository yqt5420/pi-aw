# pi-auto-title

自动为新会话生成一句话简洁标题，告别 `/resume` 里一堆笼统的首条消息。

## 功能

- 每次**新会话**首次提交信息时，把首条消息交给一个 OpenAI 兼容 LLM 端点，生成 ≤ 20 字的一句话标题。
- 通过 `pi.setSessionName()` 写回，显示在 `/resume` 会话选择器，替代默认的首条消息预览。
- **尊重手动命名**：已 `/name` / `--name` 设置过的会话不会被覆盖。
- **防重复**：每个会话只生成一次，不会每次 turn 都重命名。
- **失败零侵入**：端点不可达 / 未配置 / 超时均静默跳过，绝不阻塞正常对话。

## 配置

通过环境变量配置 LLM 端点（OpenAI 兼容，`POST {base}/chat/completions`）：

| 变量 | 必填 | 说明 |
|------|:--:|------|
| `AUTO_TITLE_BASE` | 否 | LLM 网关 base URL（如 `https://your-gateway.example/v1`）。未设时回退到 `NEWAPI_BASE_URL`（配合 pi-newapi 零配置） |
| `AUTO_TITLE_API_KEY` | 否 | API Key。未设时回退到 `NEWAPI_API_KEY` |
| `AUTO_TITLE_MODEL` | 是 | 生成标题用的模型 id（建议选便宜小模型，如 `qwen-turbo` / `deepseek-chat`） |
| `AUTO_TITLE_MAX` | 否 | 标题最大字符数，默认 `20`，范围 10–40 |

最低配置只需要 `AUTO_TITLE_MODEL`（base/key 复用 pi-newapi 的网关）：

```bash
export AUTO_TITLE_MODEL=deepseek-chat
```

> 不配置或配置不全会自动禁用，不打扰现有使用。

## 生效方式

本插件随 pi-aw 整包一起安装（见上层总 README）。单独调试可用：

```bash
pi -e extensions/pi-auto-title/extensions/index.ts
```

## 注意

- 每次新会话首次提交会多调用一次 LLM 生成标题，属于正常开销；用便宜模型可忽略。
- 生成质量取决于首条消息是否表达清晰；标题仅作会话选择器预览，不影响对话内容。