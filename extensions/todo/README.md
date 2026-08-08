# todo

Model todo list（实时 overlay，随 /reload 与对话压缩存活）。为 [@juicesharp/rpiv-todo](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) 的 **vendored 版本**——纳进 pi-aw 统一 git 管理，并已修复若干本地 bug（见下）。

## 功能

- `todo` 工具：Agent 维护任务列表（create / complete / update / delete / blockedBy 依赖）
- **实时 overlay**：编辑器上方常驻显示 Todo 面板（可折叠），头行显示 `(完成/总数)`
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
| “任务做完了还显示在列表” | overlay 完成隐藏从“内存集合 + 跨轮状态机”改为**渲染时直接过滤 completed**（纯从 store 派生，reload/压缩后不再重浮），统计口径与 `/todos` 一致 |
| “任务卡住 / 冻结” | 前台渲染会话指针失效时**自动重认领**（`hasSession`）+ 渲染回退到最近写入会话（`extensions/todo/state/store.ts`）|

## 维护 / 溯源

- 上游：`juicesharp/rpiv-mono`（MIT）→ 本目录 vendor；上游更新需**手动 sync**（vendor 后代码可改）。
- 共享库 `@juicesharp/rpiv-config`、`@juicesharp/rpiv-i18n` 作为 pi-aw **根 `dependencies`** 引入，随 `npm install` 安装。
- 保留上游 `LICENSE`；改动集中在 `todo-overlay.ts`（完成隐藏）与 `state/store.ts`（渲染指针）。