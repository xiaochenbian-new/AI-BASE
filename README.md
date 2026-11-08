# AI-BASE

给 AI agent 用的插件与 skill 集合（目前主要面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，简称 DSH）。

## 目录结构

```text
AI-BASE/
├── plugins/                 可安装的 DSH 插件包（各自独立的 npm 包）
│   └── dsh-email-plugin/    邮件发送：QQ 邮箱 / 任意 SMTP
└── skills/                  可复用的 agent skill（每个子目录一个 SKILL.md）
```

## 插件

| 插件 | 版本 | 说明 |
| --- | --- | --- |
| [dsh-email-plugin](plugins/dsh-email-plugin/README.zh.md) | 0.1.2 | 三个原生工具：`email_send` / `email_verify` / `email_status`；自带浏览器设置页，零 npm 依赖 |

### 安装 dsh-email-plugin

方式一，直接装 GitHub Release 里的 tgz：

```sh
dsh plugin --profile desktop add https://github.com/xiaochenbian-new/AI-BASE/releases/download/dsh-email-plugin-v0.1.2/dsh-email-plugin-0.1.2.tgz
```

桌面端的 `desktop` profile 由 Electron 独占管理，请用应用自带的 dsh 命令（Windows 上形如 `E:\software\dsh\resources\runtime\cli\bin\dsh.cmd`）。也可以在应用里 **插件 → 添加插件 → 安装第三方插件** 填这个地址。

方式二，克隆仓库后从本地目录安装（适合改代码）：

```sh
git clone https://github.com/xiaochenbian-new/AI-BASE.git
dsh plugin --profile desktop add ./AI-BASE/plugins/dsh-email-plugin
```

装完如果工具没出现，卸载再装一次或完全退出应用重开（宿主会缓存已加载的模块）。

### 配置

插件有浏览器设置页：

```text
http://127.0.0.1:1461/dsh-email-plugin/settings
```

端口是 DSH 的 Web 端口（本机为 1461）。也可以让 agent 调用 `email_status` 查当前地址。QQ 邮箱需要在 `mail.qq.com → 设置 → 账号 → POP3/IMAP/SMTP 服务` 生成**授权码**（不是登录密码）。

## Skill

DSH 扫描 `<name>/SKILL.md`（一层目录）或 `<name>.md`，文件以 YAML frontmatter 开头，`name`（kebab-case）与 `description` 必填：

```markdown
---
name: my-skill
description: 一句话说明这个 skill 解决什么问题、什么时候用。
---

# 正文：具体指令、步骤、示例
```

要让 DSH 发现本仓库的 `skills/`，任选其一：

- 在 DSH 配置里把 `skill-filesystem` 的 `customSkillDirs` 指向本仓库 `skills/` 目录；
- 或把需要用的 skill 目录复制/软链到 `~/.dsh/skills/`（用户级）或项目根目录的 `.dsh/skills/`（项目级）。

更多格式细节见 [skills/README.md](skills/README.md)。

## 版本与标签

每个插件独立版本，tag 命名 `<包名>-v<版本>`（例如 `dsh-email-plugin-v0.1.2`），tag 上附对应 `.tgz`，方便直接用 URL 安装。

## 许可

仓库内各插件/ skill 未单独声明许可时，默认仅供个人使用；如需复用请先确认。
