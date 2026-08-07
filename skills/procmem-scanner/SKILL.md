---
name: procmem-scanner
description: >
  进程内存扫描器。当需要从正在运行的 Windows 进程中提取 API key、token、密钥、
  序列号等敏感信息（如逆向桌面软件提取大模型 API key 时），用它扫描目标进程的
  内存空间，按 Hex 特征码（CE/CheatEngine 风格，支持 YARA）或字符串（ASCII/wide）
  搜索，可输出匹配点上下文（LLM 模式）。

  典型场景：逆向桌面软件/网页客户端，运行时 key 不落盘、只存在于内存中时，
  扫描进程内存直接捞取明文 key / JWT / token。

  用法（必须用本技能自带 uv 虚拟环境，勿用系统 python）：
  - 字符串搜索:  <skill_dir>/.venv/Scripts/python.exe procmem_scanner.py <PID> "sk-" --mode string --llm
  - Hex 搜索:    <skill_dir>/.venv/Scripts/python.exe procmem_scanner.py <PID> "48 8B ?? ?? 00" --mode hex
  - 自动模式:    不传 --mode 时自动识别（纯 hex 当 hex，否则当字符串）
  - 需先知道目标 PID（可用 tasklist 或 ps 查）。
  - LLM 模式会输出每个匹配点的 地址/Hex/ASCII 上下文 JSON，方便分析。
triggers:
  - 内存扫描: 扫内存/内存搜索/搜进程内存/scan memory/procmem
  - key提取: 提取key/提取token/捞key/挖key/apiKey/jwt在内存
  - 逆向辅助: 逆向/进程分析/特征码搜索/CE扫描/cheat engine/YARA
---

# procmem-scanner — 进程内存扫描器

## 环境（重要）

- **必须用本技能自带虚拟环境**运行，不要用系统 python：
  ```
  <skill_dir>/.venv/Scripts/python.exe
  ```
- 依赖：`yara-python`（见同目录 `requirements.txt`）。
- 该脚本是 Windows-only（用 ctypes 调 kernel32 的 ReadProcessMemory / VirtualQueryEx）。

### 首次使用前的初始化（每台 Windows 设备做一次）

`.venv` 不在 git 里，clone 后需在 skill 目录重建：

```bash
cd <skill_dir>
uv venv
# Windows:
.venv/Scripts/pip install -r requirements.txt
# 或: uv pip install -r requirements.txt
```

未装 uv 时可用 `python -m venv .venv` 替代。

## 功能

| 模式 | 说明 |
|------|------|
| `--mode string` | 搜字符串（自动 ASCII + wide 编码），如 `"sk-"`, `"apiKey"`, `"server_"` |
| `--mode hex` | 搜 Hex 特征码（CE 风格，支持 `??` 通配、`(n)` 跳转），如 `"90 (32) 00"` |
| `--mode yara` | 传完整 YARA 规则源码 |
| `--mode auto` | 默认，自动识别（纯 hex 当 hex，否则字符串） |
| `--llm` | LLM 模式，输出每个匹配点上下文 JSON（地址/hex/ascii），**推荐** |

## 用法

```bash
# 1) 找到目标进程 PID
tasklist | findstr /i 目标名

# 2) 搜字符串（推荐 LLM 模式看上下文）
<skill_dir>/.venv/Scripts/python.exe procmem_scanner.py <PID> "sk-" --mode string --llm

# 3) 搜多个常见 key 关键词（可逐次执行）
<skill_dir>/.venv/Scripts/python.exe procmem_scanner.py <PID> "apiKey" --mode string
<skill_dir>/.venv/Scripts/python.exe procmem_scanner.py <PID> "Authorization" --mode string
<skill_dir>/.venv/Scripts/python.exe procmem_scanner.py <PID> "server_" --mode string

# 4) 搜 Hex 特征（如 PE 头 4D 5A）
<skill_dir>/.venv/Scripts/python.exe procmem_scanner.py <PID> "4D 5A 90 00" --mode hex
```

## 注意事项

1. **权限**：不需要管理员，但需对目标进程有 `PROCESS_QUERY_INFORMATION` + `PROCESS_VM_READ` 权限（同用户进程基本都行）。
2. **效率**：扫的是整块内存，特征码/关键词越独特越好，减少误报和耗时。
3. **结果解读**：`--llm` 输出的 JSON 中，`address` 是绝对虚拟地址，`hex`/`ascii` 是命中点上下文。大模型根据上下文判断这是不是 key。
4. **局限**：只看到内存中的静态数据，**看不到函数调用过程**（那是 Frida 的活）。key 若加密存储/加密传输，内存里也可能是密文——此时需配合抓包/Frida。
5. **CE 差集扫描**：定位动态字段（如随操作变化的会话标题）可用"一次全量 scan + 多次 ReadProcessMemory 筛选"的思路（脚本本身是单次扫描）。

## 参考（来源）

- 原脚本出处：GenericAgent-Desktop-Windows-Portable/runtime/app/memory/procmem_scanner.py
- 复现到 pi 技能：`~/.agents/skills/procmem-scanner/`
