# todo

Model todo list（实时 overlay，随 /reload 与对话压缩存活）。为 [@juicesharp/rpiv-todo](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) 的 **vendored 版本**——纳进 pi-aw 统一 git 管理，并已修复若干本地 bug（见下）。

## 功能

- `todo` 工具：Agent 维护任务列表（create / complete / update / delete / blockedBy 依赖）
- **实时 overlay**：输入框上方常驻显示 Todo 面板（可折叠），头行显示 `(完成/总数)`；`completed` 任务以 `✓`+删除线显示，面板只在存在 `pending`/`in_progress` 任务时出现（全部完成则整体隐藏）。注：pi-web 等 web 端的 widget 是纯文本 `<pre>`，completed 只显示 `✓` 勾选、无删除线（真删除线仅在 TUI 生效）
- 状态随 `/reload`、conversation compaction 存活（从对话分支 replay 恢复）

## 命令

- `/todos` — 查看 / 交换任务列表
- 折叠快捷键：默认 `ctrl+shift+t`（可在配置里改）

## 配置

`~/.config/rpiv/todo.json`（或取 `rpiv` 命名空间）：

```json
{ "maxWidgetLines": 12, "collapseKey": "ctrl+shift+t" }
```

- `maxWidgetLines` — overlay 内容行上限
- `collapseKey` — 折叠快捷键（`"off"` 禁用）

## 本地修复（vs 上游 2.4.0）

| Bug | 修复 |
|------|------|
| “任务做完了还显示在列表 / 完成项复活” | 彻底弃用“内存集合 + 跨轮状态机”（上游那个 reload 后完成项重新冒出、要两轮才再隐藏的 ephemeral bug）。现在 overlay **纯从 store 派生**：`completed` 以 `✓`+删除线显示、不再隐藏；`deleted` 不显示；面板只在存在 `pending`/`in_progress` 时出现（全部完成则整体隐藏）。reload/压缩后显示始终一致 |
| “任务卡住 / 冻结” | 前台渲染会话指针失效时**自动重认领**（`hasSession`）+ 渲染回退到最近写入会话（`extensions/todo/state/store.ts`）|
| “pi-web 界面 overlay 不显示” | 兼容 `mode="rpc"` 的 host（pi-web / RPC 客户端）：其 `setWidget` **只支持字符串数组，忽略组件工厂**（`docs/rpc.md`）。按 `ctx.mode` 分支，非 TUI 时改用字符串数组、placement `belowEditor`（pi-web 中“belowEditor”才渲染在输入框上方，`aboveEditor` 会跑到聊天顶部）、仅内容变化才重发；TUI 仍走组件工厂 + `requestRender` 热刷新（`extensions/todo/todo-overlay.ts`、`index.ts`）|

## 维护 / 溯源

- 上游：`juicesharp/rpiv-mono`（MIT）→ 本目录 vendor；上游更新需**手动 sync**（vendor 后代码可改）。
- 共享库 `@juicesharp/rpiv-config`、`@juicesharp/rpiv-i18n` 作为 pi-aw **根 `dependencies`** 引入，随 `npm install` 安装。
- 保留上游 `LICENSE`；改动集中在 `todo-overlay.ts`（完成隐藏）与 `state/store.ts`（渲染指针）。