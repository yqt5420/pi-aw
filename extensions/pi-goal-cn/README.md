# pi-goal-cn

**目标管理（中文界面）**——上游 [pi-goal](https://github.com/earendil-works/pi-coding-agent) 的汉化版。

## 功能

- 管理 agentic 目标（goal）：进入目标、完成、记账/统计
- 中文命令 + 界面文案

## 命令

- `/goal` — 进入 / 管理目标
- （配合目标生命周期使用，如完成目标时由 agent 调用对应记账）

## 维护说明

翻译来自脚本处理上游 `pi-goal` 文案。上游更新后可用 `scripts/sync-upstream.mjs` + `scripts/translate.mjs` 重新同步+翻译。