# prompt-templates

这里的 `.md` 文件会注册成 pi 的提示词命令，文件名（去 `.md`）即命令名。

- `review.md` → 在 pi 编辑器敲 `/review` 触发
- frontmatter 的 `description` 显示在自动补全里
- 支持 `$1` `$@` `${1:-默认值}` 参数插值

详见 [pi 文档](https://github.com/earendil-works/pi-coding-agent) 的 Prompt Templates 部分。

## 加新模板

1. 在本目录建 `名字.md`
2. 写 frontmatter + 正文
3. commit push，各设备 `pi update --extensions` 自动同步

文件名规范：小写、连字符分隔（`code-review.md` → `/code-review`）。
