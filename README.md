# pi-aw

个人 [pi coding agent](https://github.com/earendil-works/pi-coding-agent) 扩展与技能集合。

一个 git package 同时声明 `extensions` + `skills`，跨设备用 `pi install git:...` 一行装全套。
不走 npm 发布——纯 git 分发，clone 即用。

## 包含内容

### Extensions（插件，7 个）

| 目录 | 说明 | 按设备配置点 |
|------|------|--------------|
| `extensions/vision-router` | 视觉通道自动维护与智能路由，让任何模型都能识图 | 环境变量 `GLM_API_KEY` / `AGNES_API_KEY` / `AGNES_BASE_URL` |
| `extensions/token-speed` | 实时显示 token 生成速度（TTFT + tokens/sec） | 无 |
| `extensions/tdai-memory` | MemoryCore 长期记忆（L0~L3、团队技能库、知识库） | `~/.pi/agent/extensions/tdai-memory/config.json`（全局）/ `.pi/tdai-memory.json`（项目级）/ 环境变量 |
| `extensions/pi-plan-mode-cn` | 只读 `/plan` 协作模式（中文界面） | 无 |
| `extensions/pi-subagents-cn` | 子代理管理（中文界面） | 无 |
| `extensions/pi-goal-cn` | 目标管理（中文界面） | 无 |
| `extensions/pi-newapi` | 自动发现 NewAPI / one-api 网关模型、定价，用 models.dev 补全真实上下文窗口 | `~/.pi/agent/newapi-config.json` / 环境变量 `NEWAPI_BASE_URL` / `NEWAPI_API_KEY` |

### Skills（技能，2 个）

| 目录 | 说明 | 平台 |
|------|------|------|
| `skills/agent-reach` | 全网调研 / 多平台搜索（小红书/推特/B站/Reddit 等 15 平台） | 跨平台 |
| `skills/procmem-scanner` | 进程内存扫描器，提取运行时内存中的 API key / token | **Windows 专用** |

## 安装

任意装好 pi 的设备，一行命令：

```bash
pi install git:github.com/yqt5420/pi-aw@main
```

pi 会：
1. clone 到 `~/.pi/agent/git/github.com/yqt5420/pi-aw`
2. 跑 `npm install` 装好运行时依赖（`@narumitw/pi-tui-kit` 等）
3. 把这行写进 `~/.pi/agent/settings.json` 的 `packages` 数组
4. 加载 `extensions/` 下 7 个 extension + `skills/` 下 2 个 skill + `prompts/` 下的提示词模板

装完重启 pi 即生效。**这套设备的 settings 不用手改。**

## 跨设备同步

```bash
# 首次（每台设备跑一次）
pi install git:github.com/yqt5420/pi-aw@main

# 以后本地改完 push，各设备拉新：
pi update --extensions
```

`pi update --extensions` 会 reconcile 到配置的 ref（`@main`），不会自动跟进到新 ref——锁版本安全。想换 ref：

```bash
pi install git:github.com/yqt5420/pi-aw@v1.0   # 换成 tag
```

## 按设备裁剪（不想用某个插件/skill）

`pi remove` 的粒度是整个 package（删整个 `pi-aw`），**不能单独卸某个 extension**。
但用 settings 的 **glob 排除** 能达到等同卸载的效果（不加载、不占 context、工具不注册）。

改 `~/.pi/agent/settings.json`，把 `pi install` 写的那行字符串改成对象形式：

### 只排除某几个（其余全装）

```json
{
  "packages": [
    {
      "source": "git:github.com/yqt5420/pi-aw@main",
      "extensions": ["extensions/**", "-extensions/tdai-memory"],
      "skills": ["skills/**", "-skills/procmem-scanner"]
    }
  ]
}
```

`-path` 是精确强制排除（即使被 `**` 包含也排除掉）。`!pattern` 是 glob 排除，效果类似。

### 只保留某几个（其余不装）

```json
{
  "packages": [
    {
      "source": "git:github.com/yqt5420/pi-aw@main",
      "extensions": ["extensions/token-speed/**", "extensions/vision-router/**"],
      "skills": []
    }
  ]
}
```

白名单写法：只列要的，其余都不加载。`skills: []` 表示一个 skill 都不加载。

### 交互式开关

```bash
pi config     # 图形化勾选，本质也是改上面的 settings
```

> 三种方式都是改 settings 的过滤规则，**一次性配置**，以后 `pi update --extensions` 仍认这套规则、自动同步到最新 ref、保留排除。

## 按设备配置（密钥 / endpoint 各设备不同）

**绝不把密钥写进 settings.json**（会随仓库同步泄密）。三类配置点：

### 1. 环境变量（最推荐，密钥走这里）

各 extension 读的环境变量见上面"包含内容"表。在系统层配（`~/.bashrc` / 系统环境变量 / `~/.pi/agent/settings.json` 里 `pi` 之外的字段 pi 不读）：

```bash
# Windows (PowerShell, 用户级)
[Environment]::SetEnvironmentVariable("GLM_API_KEY", "xxx", "User")
[Environment]::SetEnvironmentVariable("NEWAPI_BASE_URL", "http://localhost:3000", "User")

# macOS / Linux
export GLM_API_KEY=xxx >> ~/.bashrc
```

### 2. 本机独立配置文件（非敏感偏好）

tdai-memory / pi-newapi 各有本机 json，**不进 git**（`.gitignore` 已排除 `*.local.json`）：

- tdai-memory 全局：`~/.pi/agent/extensions/tdai-memory/config.json`（从 `config.example.json` 复制改）
- pi-newapi：`~/.pi/agent/newapi-config.json`

每台设备各自配，互不影响。

### 3. 项目级覆盖（某个项目特有）

tdai-memory 支持 `{项目根}/.pi/tdai-memory.json`，只对该项目生效，可提交团队共享或本机独占。

## pi-newapi 用法

自动发现 NewAPI / one-api 网关模型，用 [models.dev](https://models.dev) 目录补全真实上下文窗口 / 最大输出 / 推理能力（网关 `/api/pricing` 不含这些字段，启发式猜测不准）。

配置（每台设备各自配，不进 git）：

```json
// ~/.pi/agent/newapi-config.json
{ "baseUrl": "https://your-gateway/v1", "apiKey": "sk-..." }
```

或环境变量 `NEWAPI_BASE_URL` / `NEWAPI_API_KEY`；`/login newapi` 也可交互登录。

命令：

- `/newapi-url <url>` — 设网关地址，保存后自动重载
- `/newapi-refresh-meta [proxy]` — curl 重拉 models.dev 元数据（可选代理参数，如 `http://127.0.0.1:12080`）
- `/newapi-list` — 列出模型 + 上下文窗口 / 最大输出 / 来源

上下文来源优先级：`~/.pi/agent/modelsdev-cache.json`（刷新写入）> 随包 `models.dev.snapshot.json`（零网络基准）> 厂商启发式。首次无需联网即有准确值。

> 思考档位说明：网关对 `reasoning_effort` 不做枚举校验，实测各模型为开/关型而非真 4 档梯度，pi 默认档位选择不报错；精确档位无法从任何目录获取。

## 提示词模板（prompt templates）

`prompts/` 里的 `.md` 文件会注册成 `/名字` 命令，在 pi 编辑器敲 `/` 触发自动补全。

内置示例：`prompts/review.md` → 敲 `/review` 展开成代码审查提示词。

### 格式

```markdown
---
description: 审查暂存的 git 改动
argument-hint: "<范围>"
---
审查 `git diff --cached` 的改动，重点关注：
1. Bug 与逻辑错误
2. 安全问题
3. 错误处理
```

- 文件名（去 `.md`）即命令名：`review.md` → `/review`
- `description` 可选，显示在补全列表
- `argument-hint` 可选，显示参数提示
- 支持 `$1` `$@` `${1:-默认值}` 参数插值

### 调用

```
/review                      # 无参数
/commit fix auth            # $1=fix, $2=auth
/component Button "onClick" # $1=Button, $@=onClick
```

### 按设备裁剪提示词

和 extension/skill 一样，settings 里用对象形式过滤：

```json
{
  "packages": [
    {
      "source": "git:github.com/yqt5420/pi-aw@main",
      "prompts": ["prompts/review.md"]
    }
  ]
}
```

`prompts: []` 表示一个模板都不加载。详见 [pi prompt-templates 文档](https://github.com/earendil-works/pi-coding-agent)。

## procmem-scanner 的虚拟环境（Windows 专用）

`.venv` 不进 git，每台 Windows 设备首次使用前在 skill 目录重建：

```bash
cd ~/.pi/agent/git/github.com/yqt5420/pi-aw/skills/procmem-scanner
uv venv
.venv/Scripts/pip install -r requirements.txt
```

未装 uv 时可用 `python -m venv .venv` 替代。非 Windows 设备在 settings 排除该 skill（见"按设备裁剪"）。

## 目录结构

```
pi-aw/
├── package.json              # pi package 主清单：pi.extensions + pi.skills + 依赖
├── .gitignore
├── extensions/               # 7 个 extension，各自子 package.json 指明入口
│   ├── vision-router/{ extensions/vision-router.ts, package.json }
│   ├── token-speed/{ extensions/token-speed.ts, package.json }
│   ├── tdai-memory/{ index.ts, lib/, config.example.json, package.json }
│   ├── pi-newapi/{ extensions/, package.json }
│   ├── pi-plan-mode-cn/{ src/, scripts/, zh-cn.json, package.json }
│   ├── pi-subagents-cn/{ src/, scripts/, zh-cn.json, package.json }
│   └── pi-goal-cn/{ src/, scripts/, zh-cn.json, package.json }
├── skills/                   # 2 个 skill
│   ├── agent-reach/{ SKILL.md, references/ }
│   └── procmem-scanner/{ SKILL.md, procmem_scanner.py, requirements.txt }
└── prompts/                  # 提示词模板（.md 文件 → /名字 命令）
    ├── README.md             # 模板说明
    └── review.md             # 示例：/review
```

每个 extension 子目录的 `package.json` 只含 `pi.extensions` 指向入口文件（不是独立 npm 包，无 name/version/dependencies）——这样 pi 加载时按各自入口精确加载，文件名/结构不用改。

## 维护

### 改了代码后同步到各设备

```bash
git add . && git commit -m "改动说明" && git push
# 各设备：pi update --extensions
```

### 加新 extension

1. `extensions/my-new-ext/` 建目录，放源码
2. 加一个子 `package.json`：`{ "pi": { "extensions": ["./入口.ts"] } }`
3. 若有 npm 运行时依赖，加到**根** `package.json` 的 `dependencies`
4. commit push，各设备 `pi update --extensions` 自动拉新并重装依赖

### 加新 skill

1. `skills/my-new-skill/` 建目录，放 `SKILL.md`（frontmatter 必须有 `name` + `description`）
2. 有外部依赖的 skill 自行在 SKILL.md 写清 setup 步骤（pi 对 skill 目录不跑 `npm install`）
3. commit push 即可

### 加新 prompt 模板

1. `prompts/名字.md` 建文件（文件名即命令名，小写连字符）
2. 写 frontmatter（`description` 可选）+ 正文
3. commit push，各设备 `pi update --extensions` 后敲 `/名字` 可用

## 关于 npm 发布

本仓库**不走 npm**。若想单独逐包发布到 npm，见姊妹仓库 [pi-extensions](https://github.com/yqt5420/pi-extensions)（多包 monorepo + GitHub Actions OIDC 发布）。
