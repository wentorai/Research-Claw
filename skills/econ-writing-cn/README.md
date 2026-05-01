# econ-writing-cn

> 中文经济学论文写作助手 — Claude Code Skill

面向《经济研究》《金融研究》《管理世界》《会计研究》《管理科学学报》《数量经济技术经济研究》等顶级中文期刊，提供从选题、提纲、引言、识别策略、结果、稳健性、结论到 R&R 评审回复的全流程写作指引。

本 Skill 是 Research-Claw（科研龙虾）项目的一部分，针对中文学术写作场景独立从零撰写。

## 安装

将本目录复制（或建立软链接）到 Claude Code 的 skills 目录：

```bash
# Claude Code
ln -s "$(pwd)/econ-writing-cn" ~/.claude/skills/econ-writing-cn

# Codex（可选）
ln -s "$(pwd)/econ-writing-cn" ~/.codex/skills/econ-writing-cn
```

如果使用 `~/.ai-shared/sync-skills.sh` 同步脚本，将本目录放置于 `~/.codex/skills/` 后运行该脚本即可。

## 使用

启动 Claude Code 后，键入：

```
/econ-writing-cn 我要写一篇关于绿色信贷政策对企业全要素生产率影响的论文，目标投稿《金融研究》，请帮我搭提纲。
```

或在自由对话中明确说出："请使用 econ-writing-cn 帮我润色摘要"。

## 目录结构

```
econ-writing-cn/
├── SKILL.md                              # Skill 主入口
├── references/
│   ├── journals.md                       # 六大顶级中文期刊速览
│   ├── citation-gbt7714.md               # GB/T 7714-2015 引用规范示例
│   ├── abstract-templates.md             # 中英文摘要模板
│   ├── identification-strategies.md      # 各识别策略写作指引
│   └── common-mistakes.md                # 常见写作误区
├── prompts/
│   ├── outline.md                        # 提纲生成
│   ├── intro.md                          # 引言写作
│   ├── results.md                        # 实证结果
│   └── referee-response.md               # R&R 评审回复
├── tests/                                # 结构性测试
├── LICENSE                               # Apache 2.0
└── NOTICE                                # 致谢与归属
```

## 测试

```bash
cd econ-writing-cn
python3 -m pytest tests/ -v
```

测试内容：

1. SKILL.md 存在且包含 `name`、`description` 字段的 YAML frontmatter
2. 所有声明的 references / prompts 文件均存在
3. 每个 markdown 文件大于 200 字符（避免空文件）
4. LICENSE 包含 "Apache License"
5. NOTICE 包含 "hanlulong/econ-writing-skill" 致谢

## 许可证

Apache License 2.0。本 Skill 受到 [hanlulong/econ-writing-skill](https://github.com/hanlulong/econ-writing-skill)（MIT License）的概念启发；所有内容独立撰写，未复制任何源代码或文本。详见 `NOTICE` 与 `LICENSE`。

## 反馈

请通过 Research-Claw 项目主仓库提交 issue 与 PR。
