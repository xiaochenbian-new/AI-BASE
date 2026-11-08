# Skills

给 DSH agent 用的可复用 skill。每个 skill 一个目录，内含 `SKILL.md`：

```text
skills/
└── <name>/
    ├── SKILL.md        # 必需：YAML frontmatter + 指令正文
    ├── references/     # 可选：参考文档
    ├── scripts/        # 可选：脚本
    └── assets/         # 可选：素材
```

## SKILL.md 格式

```markdown
---
name: kebab-case-name
description: 一句话说明这个 skill 解决什么问题、什么时候该用（模型靠它决定是否加载）。
whenToUse: 可选，补充使用时机。
---

# 标题

具体的步骤、规则、示例。写得越具体，模型执行越稳定。
```

必填字段：`name`（kebab-case）、`description`。可选字段：`whenToUse`、`metadata`、`disable-model-invocation`、`user-invocable`。

## 如何让 DSH 发现

DSH 的 skill 提供方按固定根目录扫描（只扫一层）：

| 优先级 | 根目录 |
| --- | --- |
| 项目 | `<项目根>/.dsh/skills` |
| 项目 | `<项目根>/.agents/skills` |
| 自定义 | 配置里的 `customSkillDirs` |
| 用户 | `~/.dsh/skills` |
| 用户 | `~/.agents/skills` |

最省事的方式：把本仓库 `skills/` 加进 `customSkillDirs`，或者把需要的 skill 目录复制到 `~/.dsh/skills/`。

## 约定

- 一个 skill 只解决一类任务，`description` 写清楚触发条件。
- 需要脚本时放进 `scripts/`，并在正文里写明怎么运行、依赖什么环境。
- 不要把密钥、token、个人路径写进 skill。
