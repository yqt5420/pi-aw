# pi-newapi

自动发现 **NewAPI / one-api 网关**模型、定价，并用 [models.dev](https://models.dev) 目录补全真实上下文窗口 / 最大输出 / 推理能力（网关 `/api/pricing` 不含这些字段，启发式猜测不准）。

## 配置

每台设备各自配，**不进 git**：

```json
// ~/.pi/agent/newapi-config.json
{ "baseUrl": "https://your-gateway/v1", "apiKey": "sk-..." }
```

或环境变量 `NEWAPI_BASE_URL` / `NEWAPI_API_KEY`；`/login newapi` 也可交互登录。

## 命令

- `/newapi-url <url>` — 设网关地址，保存后自动重载
- `/newapi-refresh-meta [proxy]` — curl 重拉 models.dev 元数据（可选代理参数）
- `/newapi-list` — 列出模型 + 上下文窗口 / 最大输出 / 来源

上下文来源优先级：
`~/.pi/agent/modelsdev-cache.json`（刷新写入）> 随包 `models.dev.snapshot.json`（零网络基准）> 厂商启发式。首次无需联网即有准确值。

> 思考档位说明：网关对 `reasoning_effort` 不做枚举校验，实测各模型为开/关型而非真 4 档梯度，pi 默认档位选择不报错；精确档位无法从任何目录获取。