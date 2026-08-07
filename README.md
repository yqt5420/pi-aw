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
| `extensions/pi-newapi` | 自动发现 NewAPI / one-api 网关的模型、定价、推理兼容 | `~/.pi/agent/newapi-config.json` / 环境变量 `NEWAPI_BASE_URL` / `NEWAPI_API_KEY` |

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
4. 加载 `extensions/` 下 7 个 extension + `skills/` 下 2 个 skill

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
└── skills/                   # 2 个 skill
    ├── agent-reach/{ SKILL.md, references/ }
    └── procmem-scanner/{ SKILL.md, procmem_scanner.py, requirements.txt }
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

## 关于 npm 发布

本仓库**不走 npm**。若想单独逐包发布到 npm，见姊妹仓库 [pi-extensions](https://github.com/yqt5420/pi-extensions)（多包 monorepo + GitHub Actions OIDC 发布）。
