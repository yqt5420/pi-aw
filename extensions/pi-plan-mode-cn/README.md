# pi-plan-mode-cn

**只读 Plan 协作模式（中文界面）**——上游 [pi-plan-mode](https://github.com/earendil-works/pi-coding-agent) 的汉化版（含 `如何拟定 plan` 指南 / 命令 / 补全工具 / 界面文案都翻译成中文）。

## 功能

- `/plan` 进入只读的 Plan 模式：先出方案、改代码前先对齐，避免直接动文件
- 中文交互界面 + 文案
- 配套 completion tool（plan 拟定辅助）

## 命令

- `/plan` — 进入/查看 plan（只读）

## 维护说明

翻译来自脚本处理上游 `pi-plan-mode` 的英文文案。上游更新后可用 `scripts/sync-upstream.mjs` + `scripts/translate.mjs` 重新同步+翻译。

> 提示词命令也支持输入 `/plan` 在编辑器里触发补全。