# NIH R01 Specific Aims / Significance / Innovation / Approach

NIH R01 (Research Project Grant) 是 NIH 旗舰资助类型，资助独立研究者开展 hypothesis-driven 研究。本文聚焦四大核心 sections 写作要点。

## 1. Page Limits & Section Map（PHS 398 Research Plan）

NIH 标准 R01 申请的 Research Strategy 部分**最多 12 页**（不含 Specific Aims），结构为：

| Section | 页数 | 用途 |
|---------|------|------|
| Specific Aims | 1 page | 项目灵魂；多数评审先看这页决定是否往后读 |
| Research Strategy | 12 pages total | 含下列 3 个子 section |
| ├ Significance | ~2-3 pages | 为什么这个问题重要 |
| ├ Innovation | ~1 page | 与现状相比有何新颖 |
| └ Approach | ~7-9 pages | 怎么做 + pitfalls + alternatives |
| Bibliography | 不计页 | 引文 |
| Biosketch | 5 pages × 每位 key personnel | PI / co-I 履历 |
| Budget + Justification | 不计 | 见 budget-international.md |

## 2. Specific Aims（最关键 1 页）

NIH 评审常说："**The Specific Aims page is your proposal**"。1 页通常 4 段：

### Para 1 — Big Picture / Knowledge Gap (4-6 sentences)

- 第 1 句：钩住的疾病 / 现象（health relevance）
- 第 2-3 句：当前状态 / 已知
- 第 4-5 句：critical gap（**用粗体或斜体强调**）
- 第 6 句：long-term goal of your lab

### Para 2 — Objective + Central Hypothesis + Rationale (3-5 sentences)

- "The objective of this proposal is to..."（具体到本项目）
- "Our central hypothesis is..."（**整个项目最重要的一句**，必须可证伪）
- "The rationale for this hypothesis is supported by our preliminary data showing..."

### Para 3 — Specific Aims (列表，2-4 个 aims)

每个 aim 一段。每段写：

- Aim 标题（动词开头："Determine..." / "Test..." / "Identify..."）
- Working hypothesis（每个 aim 的 sub-hypothesis）
- Approach 1-line summary

**关键原则**：

- **Aims 之间不能有"如果 Aim 1 失败 Aim 2 就垮"的串联依赖**。三个 aims 应可独立完成。
- 每个 aim 应可独立产出 1-2 篇高质量论文。
- 不要写 "**Develop a tool**" 当 aim — NIH 看中 **mechanistic insight**，不是工具开发。

### Para 4 — Innovation Summary + Expected Outcomes + Impact (3-5 sentences)

- "This proposal is innovative because..."
- "Expected outcomes include..."
- "Positive impact: this work will provide..."

## 3. Significance（2-3 pages）

回答"so what"。结构建议：

1. **Magnitude of the problem**：流行病学数据、经济负担、未满足的临床需求
2. **Current state of the field**：what is known + what is NOT known
3. **Critical barriers**：阻止该领域前进的 specific barriers
4. **How this project addresses the barriers**：具体到本项目能 contribute 什么
5. **Significance of expected outcomes**：从临床、机制、translational 三角度阐述

**写作风格要点**：

- 使用粗体 / 列表分明的 subsection headers
- 每个核心论断必须有 reference 支持
- 不要写一整页的"叙事散文"；NIH 评审在飞机上读 30 份本子，结构化呈现是体面

## 4. Innovation（约 1 page）

NIH 把 Innovation 单列一项评分。需要论证至少一项：

- **Conceptual innovation**：新假设 / 新理论框架
- **Methodological innovation**：新技术 / 新工具
- **Translational innovation**：基础到临床的新桥梁

**反例**（评审常给低分）：

- "We will use CRISPR to..." — CRISPR 已不是 innovation，是 standard tool
- "This is the first study to..." — 必须解释 why first matters

**正例**：

- "This proposal introduces a novel conceptual framework that integrates A, B, and C in a manner not previously attempted, supported by our preliminary data demonstrating..."

## 5. Approach（7-9 pages，篇幅最大）

按 Specific Aims 顺序，每个 aim 一节：

```
Aim 1. [aim 标题]

  Rationale (1 paragraph)
    - 为什么这么做
    - 已有 preliminary data 概要

  Experimental Design
    - Sub-aim 1.1: ...
    - Sub-aim 1.2: ...
    （含具体方法、样本量、统计检验）

  Expected Results

  Potential Pitfalls and Alternative Strategies
    - Pitfall: 如果 X 出现这种情况
    - Alternative: 我们将采用 Y 替代

  Rigor and Reproducibility
    - 如何避免 batch effect / sex 作为生物变量 / 盲法 / pre-registration
```

### Approach 高频踩雷点

1. **缺少 power analysis / sample size justification**：每个量化实验都要写 expected effect size + power
2. **缺少 sex as a biological variable**：NIH 自 2016 年起强制要求
3. **缺少 alternative strategies**：评审最常诟病"作者似乎没想过实验失败的可能"
4. **统计方法过于简单**：只写 "Student's t-test" — 多重比较校正、纵向数据 mixed models 都要明示
5. **缺少 rigor & reproducibility 段落**：authentication of key resources / data sharing plan

## 6. Preliminary Data 的位置

通常**散布在 Significance 和 Approach** 中，不单列。每段 preliminary data 必须含：

- Figure / panel 引用
- Methods 简述（n、统计）
- Conclusion（**用粗体的一句话**）
- Connection 到对应的 specific aim

## 7. NIH 评分体系

每位 reviewer 给 1-9 分（1 最优）：

| Criterion | 权重提示 |
|-----------|---------|
| Significance | 高 |
| Investigator(s) | 中（看 biosketch） |
| Innovation | 高 |
| Approach | 最高（4 项里最重） |
| Environment | 一般不卡 |

**Overall Impact Score**（Priority Score）= 25 × min summary score (越低越好)。Priority Score ≤ 30 通常进入 funding 范围（不同 IC 不同，详见 NIH RePORT）。

## 8. Resubmission 策略

R01 通常需要 1-2 次 resubmit。Resubmission 要含 **Introduction to Resubmission (1 page)**：

- 逐条回应 prior reviewers' critiques（**必须 verbatim 引用 critique**）
- 用 **bold** / **italic** / **track changes** 标识本次修改的位置
- 不要争辩；要认错并展示改进

## 9. 中国 PI 申请 R01 的现实

- 中国境内 PI 单独申请 R01 极少；常见路径为美方 PI 主导 + 中国 collaborator subaward
- 如 PI 在美机构有 secondary appointment，可作为 contact PI 申请（multiple-PI plan 必须写得清楚）
- **NIH 资金不可用于资助"非美方实体进行的研究"**，subaward 比例需谨慎；近年对涉外合作合规审查更严，留意 NIH foreign component disclosure 要求
