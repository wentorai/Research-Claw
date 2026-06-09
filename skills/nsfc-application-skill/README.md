# nsfc-application-skill

国家自然科学基金 (NSFC) 申请书写作 SOP — Research-Claw Skill。

## 简介

本 Skill 为撰写 **国家自然科学基金委 (NSFC)** 项目申请书提供结构化指引，覆盖：

- **8 类项目**：面上 / 青年 / 重点 / 重大 / 杰青 / 优青 / 创新群体 / 国际合作
- **5 大模块**：立项依据 / 研究内容 / 研究方案 / 创新点 / 工作基础
- **预算编制**：直接费用 + 间接费用各科目规范
- **评审视角**：函评 5 维打分 + 会评常见退稿信号
- **学部代码**：7 大学部 + 二级学科代码核对

## 目录结构

```
nsfc-application-skill/
├── SKILL.md                 # 主入口与章节模板
├── references/
│   ├── project-types.md     # 8 类项目对比
│   ├── section-template.md  # 5 大模块字数与写作要点
│   ├── budget-guide.md      # 预算编制规范
│   ├── disciplines-codes.md # 7 大学部 + 二级学科代码
│   ├── reviewer-perspective.md # 评审专家视角
│   └── common-mistakes.md   # 高频退稿原因
├── prompts/
│   ├── lipoy-yiju.md        # 立项依据
│   ├── research-content.md  # 研究内容
│   ├── research-plan.md     # 研究方案
│   ├── innovation.md        # 创新点
│   └── basis.md             # 工作基础
├── tests/                   # 结构性 pytest
├── LICENSE                  # Apache 2.0
└── NOTICE
```

## 使用方法

在 Claude Code 中加载本 Skill 后，可直接：

```
/nsfc-application-skill 帮我审一遍这份面上项目申请书的"研究方案"章节
/nsfc-application-skill 我要申请青年项目，给我一份立项依据的初稿
```

或在对话中显式引用 `references/` 与 `prompts/` 中的具体文件。

## 数据来源与免责声明

- 内容基于 NSFC 公开发布的《项目指南》《申请须知》《申请书撰写提纲》。
- 字数 / 比例 / 代码 / 预算上限等会按年度调整，**最终请以当年 NSFC 官网公布的最新文件为准**。
- 本 Skill 不替代申请人所在单位科研处的合规审核与小同行预审。
- 申请书须为申请人原创，严禁抄袭或代写。

## License

Apache License 2.0 — 详见 `LICENSE`。
