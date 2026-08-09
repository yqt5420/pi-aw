# pi-goal-cn

**目标管理（中文界面）**——上游 `@narumitw/pi-goal` 的汉化版。

## 功能

- 管理 agentic 目标（goal）：进入目标、完成、记账/统计（基线上游 **0.49.7**）
- 中文命令 + 界面文案
- 保留两处本地 bugfix：状态文件原子写（tmp+rename）、显式暂停时清除 safety_pause 残留原因

## 命令

- `/goal` — 进入 / 管理目标
- （配合目标生命周期使用，如完成目标时由 agent 调用对应记账）

## 维护说明

翻译来自脚本处理上游 `@narumitw/pi-goal` 文案，映射表位于 `zh-cn.json`。

- 同步：`scripts/sync-upstream.mjs`（或 `--force` 强制）
- 单独翻译重放：`scripts/translate.mjs <上游包目录> --out <输出目录>`
- 注意：脚本依赖 `package.json` 的 `version` 字段（形如 `<上游版本>-cn.N`）判断基线；tar 解压在 Windows/MSYS 下可能因 `C:` 路径解析失败，需手动下载上游包到临时目录后直接跑 `translate.mjs`。
- 同步后需手动重放本地两处 bugfix（persistence.ts 原子写、runtime.ts 显式暂停的 safetyPauseCause 清理），否则会被上游源码覆盖。