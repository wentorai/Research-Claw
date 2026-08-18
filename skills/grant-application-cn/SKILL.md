---
name: grant-application-cn
description: 综合资助申请书写作助手，覆盖国内（国家社科基金、教育部人文社科、省部级、博士后基金）与国际（NIH R01、NSF CAREER、ERC、MSCA）主流项目。提供项目类型对比、各模块写作 prompt、CV / track record 模板、预算编制规范。当用户撰写资助申请、对比不同项目要求、或需要按 NIH / NSF / ERC 等具体格式组织叙事时调用本 Skill。与 nsfc-application-skill (NSFC 专项) 互补。
tags: [grant, funding, nssf, moe, nih, nsf, erc, msca, application, chinese, international]
version: 0.1.0
author: HaonanAlex
license: Apache-2.0
---

# grant-application-cn — 综合资助申请书写作 SOP

## 适用场景

本 Skill 服务于撰写**国内外多类资助项目**申请书的科研工作者。常见任务：

- 在国内国际多个项目类型之间做选择和定位（条件 / 资助强度 / 周期 / 命中率）
- 起草、改写、审阅各模块（significance / innovation / approach / track record / budget）
- 按 NIH、NSF、ERC、MSCA 等海外资助机构的**叙事体例**重组中国背景科学家的研究计划
- 按国家社科基金、教育部人文社科、省部级基金的体例完成立项依据 / 研究内容 / 研究方法
- 编制预算（含国际项目 direct vs indirect cost / overhead）

> 与 `nsfc-application-skill` 互补：那里只覆盖国家自然科学基金；本 Skill 覆盖**社科 / 人文 / 海外**等更广谱系。

## 覆盖项目谱系

### 国内（详见 `references/grant-types-china.md`、`nssf-guide.md`、`moe-humanities.md`）

- **国家社科基金**（一般 / 青年 / 重点 / 重大 / 后期资助 / 西部）
- **教育部人文社科基金**（规划 / 青年 / 西部和边疆 / 新世纪人才）
- **省部级**：北京市自然科学基金、上海市科委、广东省自然科学基金、各省社科规划办
- **博士后**：博新计划、博士后特别资助、中国博士后科学基金面上 / 特别资助

### 国际（详见 `references/grant-types-international.md` 及各专项文件）

- **NIH**：R01（独立研究）、R03（小项目）、R21（探索性 / 高风险）、K（career development）
- **NSF**：CAREER（青年学者）、Standard Grant、RAPID（应急）、EAGER（早期）
- **ERC**：Starting / Consolidator / Advanced / Synergy
- **MSCA (Marie Skłodowska-Curie)**：Postdoctoral Fellowships、Doctoral Networks、Staff Exchanges

## 核心原则

1. **先选项目，再写本子**：项目类型决定**叙事体例**与**评审视角**。错误的项目类型选择是最常见的浪费工时来源。
2. **评审视角驱动**：每个项目都有独特的评审鄙视链 — NIH 看 specific aims 是否够 sharp，NSF 看 broader impacts 是否落地，ERC 看 PI 的 track record 是否 ground-breaking，国家社科基金看选题是否服务于"思想理论建设"。
3. **可行性 = 硬证据**：preliminary data / pilot study / 已发表 / 已掌握技术 / 已有平台与样本数据，五选其一以上。
4. **预算与研究内容互证**：预算单独看不出问题，但与研究内容对照看就能露馅。
5. **国际项目的中国 PI 痛点**：CV / track record 的"国际可读性"远比"奖项数量"重要。论文期刊用全名；中文奖项要英文化但不夸大。

## 模块写作模板

各类项目的核心模块结构高度相似，可映射到 6 个通用模块：

| 通用模块 | 国家社科 | NIH R01 | NSF | ERC |
|---------|---------|---------|-----|-----|
| 重要性 | 选题价值 + 文献综述 | Significance | Intellectual Merit | Ground-breaking nature |
| 创新点 | 创新之处 | Innovation | Intellectual Merit (新颖性) | Ambition / High-risk-high-gain |
| 研究方案 | 研究思路 + 方法 | Approach | Research Plan | Methodology |
| PI / 团队 | 课题组介绍 | Biosketch | Biographical Sketch | CV + Track Record |
| 时间线 | 研究进度 | Timeline | Project Timeline | Work Plan |
| 预算 | 经费预算 | Budget Justification | Budget Justification | Resources Justification |

详细 prompt 见 `prompts/` 目录：
- `prompts/proposal-outline.md` — 通用提纲生成（自动识别项目类型）
- `prompts/significance.md` — 重要性 / 立项依据 / Hook（含 30 秒 hook 模板 + reviewer 5 问）
- `prompts/innovation.md` — 创新点
- `prompts/approach.md` — 研究方案 / Approach
- `prompts/pi-bio.md` — 个人简介 / NIH Biosketch / NSF Bio / ERC CV+Track Record / 国家社科申请人
- `prompts/timeline-budget.md` — 时间线 + 预算
- `prompts/elevator-pitch.md` — 30 秒 5 句电梯演讲（适用 abstract / aims / personal statement / synopsis）

跨基金通用原则与"高分短语库"见 `references/grantsmanship-essentials.md`。

## 国内 vs 国际的体例差异

- **行文密度**：国内本子鼓励"满版式"论证，国际项目（特别是 NIH / ERC）鼓励**白边 + 加粗 + 列表**式结构化呈现。
- **创新点表达**：国内强调"国家战略需求 + 学科前沿"；NSF / NIH 强调"知识 gap → 技术突破"；ERC 强调"high-risk / high-gain"。
- **PI 介绍**：国内列代表作；NIH 用 5-page biosketch（Personal Statement + Positions + Contributions to Science）；ERC 用 3-page CV + 5-page track record。
- **预算**：国内分直接 / 间接费用；国际分 direct cost + indirect cost (overhead)，overhead rate 由所在机构与资助方协议决定（详见 `references/budget-international.md`）。

## 评审视角自检清单

- **国家社科基金**：选题禁区 / 文献综述深度 / 研究方法适配 / 预期成果可量化
- **NIH R01**：specific aims 是否各自独立可证伪 / significance 是否答了"so what" / approach 是否含 alternative strategies 与 pitfalls
- **NSF**：broader impacts 是否具体到人群 + 渠道 + 评估指标 / intellectual merit 是否有可检验的 hypotheses
- **ERC**：是否真正 ground-breaking / PI 的 track record 是否撑得起 high-risk 项目 / 是否有 plan B
- **MSCA**：fellow / supervisor 双向匹配 / two-way knowledge transfer / career development plan

详见各 references/ 文件。

## 工作模式

- **scoping（选项目）**：根据 PI 资历 / 课题阶段 / 学科 → 推荐合适项目类型
- **drafting（起草）**：从研究问题出发起草各模块
- **translating（中→英 / 英→中）**：把已有中文本子改写成 NIH/NSF/ERC 体例，或反过来
- **polishing（润色）**：在不改变原意前提下提升论证密度与体例合规
- **auditing（自审）**：以函评 / panel 视角逐条检查退稿信号
- **budgeting（预算）**：根据研究内容反推合理预算（含国际项目 overhead）

## 注意事项

- "申请条件 / 资助强度 / 周期 / 命中率"等数据**仅作参考**，每年指南 / RFA 可能调整。**最终请以当年官方最新文件为准**。
- "命中率"等敏感数字本 Skill 仅引用公开统计（如 NIH 官网公布的 funding rate）。
- 本 Skill 不替代本单位科研处审核 / 海外合作单位的 sponsored projects office 审核。
- 申请书内容必须为申请人**原创**，严禁抄袭、代写或盗用他人未公开材料。
- 国际项目跨国合作时还需注意出口管制（ITAR / EAR）、伦理审查（IRB / IACUC）、数据合规（GDPR / 个人信息保护法）等额外要求。
