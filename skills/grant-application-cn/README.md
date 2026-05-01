# grant-application-cn

综合资助申请书写作 SOP，覆盖国内外主流资助项目。是 Research-Claw 系列 Skill 之一，与 `nsfc-application-skill`（仅 NSFC）互补。

## 覆盖范围

**国内**：国家社科基金（一般 / 青年 / 重点 / 重大 / 后期 / 西部）、教育部人文社科、北京 / 上海 / 广东省部级、博新计划 / 博士后特别资助。

**国际**：NIH（R01 / R03 / R21）、NSF（CAREER / Standard / RAPID）、ERC（Starting / Consolidator / Advanced）、Marie Skłodowska-Curie。

## 目录结构

```
grant-application-cn/
├── SKILL.md                   # Skill 主入口（含 frontmatter）
├── references/                # 项目类型与领域知识
│   ├── grant-types-china.md
│   ├── grant-types-international.md
│   ├── nssf-guide.md
│   ├── moe-humanities.md
│   ├── nih-r01.md
│   ├── nsf-broader-impacts.md
│   ├── erc-cv-and-track-record.md
│   └── budget-international.md
├── prompts/                   # 写作阶段 prompt
│   ├── proposal-outline.md
│   ├── significance.md
│   ├── innovation.md
│   ├── approach.md
│   ├── pi-bio.md
│   └── timeline-budget.md
├── tests/                     # 结构性测试
├── LICENSE                    # Apache 2.0
└── NOTICE                     # 引用与原创声明
```

## 用法

由 Claude Code 自动识别 `SKILL.md` frontmatter 触发；用户也可直接 `@grant-application-cn` 调用。

## 测试

```bash
cd grant-application-cn
python3 -m pytest tests/ -v
```

## License

Apache 2.0. See `LICENSE` and `NOTICE`.
