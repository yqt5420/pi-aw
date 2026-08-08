# pi-aw

个人 [pi coding agent](https://github.com/earendil-works/pi-coding-agent) 扩展集合。

git package 声明 `extensions` + `prompts`，跨设备一行 `pi install git:...` 装全套，纯 git 分发。

## 插件一览

| 目录 | 一句话 | 详细文档 |
|------|--------|:--:|
| `extensions/vision-router` | 视觉通道自动维护与智能路由，让任何模型都能识图 | [README](extensions/vision-router/README.md) |
| `extensions/token-speed` | 实时显示 token 生成速度（TTFT + tokens/sec）+ 缓存命中率 + 子代理支持，CJK 感知估算 | [README](extensions/token-speed/README.md) |
| `extensions/todo` | 模型 todo 实时 overlay，随 /reload 存活（vendored from rpiv-todo + 修复）| [README](extensions/todo/README.md) |
| `extensions/tdai-memory` | MemoryCore 长期记忆（L0~L3、团队技能库、知识库）| [README](extensions/tdai-memory/README.md) |
| `extensions/pi-newapi` | 自动发现 NewAPI 网关模型并用 models.dev 补全上下文窗口 | [README](extensions/pi-newapi/README.md) |
| `extensions/pi-plan-mode-cn` | 只读 `/plan` 协作模式（中文）| [README](extensions/pi-plan-mode-cn/README.md) |
| `extensions/pi-subagents-cn` | 子代理管理（中文）| [README](extensions/pi-subagents-cn/README.md) |
| `extensions/pi-goal-cn` | 目标管理（中文）| [README](extensions/pi-goal-cn/README.md) |
| `extensions/pi-auto-title` | 自动为新会话生成一句话标题，尊重手动 `/name` | [README](extensions/pi-auto-title/README.md) |

> 每个插件的**功能细节、配置方法、命令**见各自目录下的 `README.md`。

## 安装

```bash
pi install git:github.com/yqt5420/pi-aw@main
```

pi 会 clone 到 `~/.pi/agent/git/github.com/yqt5420/pi-aw`、装依赖、写进 settings 的 `packages` 数组、加载全部 extension + `prompts/`。装完重启 pi 生效。

## 跨设备同步

```bash
# 各设备首次
pi install git:github.com/yqt5420/pi-aw@main
# 本地改完 push 后，各设备更新
pi update --extensions
```

`pi update --extensions` reconcile 到配置的 ref（`@main`），锁版本安全。

## 按设备裁剪（可选）

`pi remove` 只支持整体卸载整个 package；要单独禁用某插件，改 `~/.pi/agent/settings.json` 里该 package 为对象形式，用扩展 **glob 排除/白名单**：

```json
{ "packages": [ { "source": "git:...@main",
    "extensions": ["extensions/**", "-extensions/tdai-memory"] } ] }
```

或 `pi config` 图形化勾选。详见 [pi 文档](https://github.com/earendil-works/pi-coding-agent)。

## 提示词模板

`prompts/*.md` 注册成 `/名字` 命令（如 `prompts/review.md` → `/review` 代码审查）。带参数插值 `$1 $@ ${1:-默认}`。

## 目录结构

```
pi-aw/
├── package.json          # pi 主清单
├── extensions/           # 7 个插件，各自 package.json 指向入口 + README.md
│   ├── vision-router/
│   ├── token-speed/
│   ├── tdai-memory/      # index.ts + lib/ + README.md
│   ├── pi-newapi/        # extensions/ + README.md
│   ├── pi-plan-mode-cn/
│   ├── pi-subagents-cn/
│   └── pi-goal-cn/
└── prompts/review.md     # 提示词模板示例
```

## 维护

- 改完代码：`git add . && git commit && git push`，各设备 `pi update --extensions`
- 加插件：建 `extensions/xxx/` + 子 `package.json` + 根 package.json 加依赖 + 写 `README.md`
- 加提示词：建 `prompts/名字.md`（frontmatter + 正文）

## 关于 npm 发布

本仓库不走 npm。需逐包发布见姊妹仓库 [pi-extensions](https://github.com/yqt5420/pi-extensions)（多包 monorepo + OIDC 发布）。