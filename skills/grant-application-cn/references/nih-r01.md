# NIH R01: Specific Aims / Significance / Innovation / Approach

NIH R01 (Research Project Grant) 是 NIH 旗舰资助类型，资助独立研究者开展 hypothesis-driven 研究。**全篇最关键的一页是 Specific Aims**——多数 reviewer 只读这页就形成了对项目的总体印象（"impression score"），后面 12 页 Research Strategy 主要在确认或修正这个印象。

> 适用范围：本文针对 R01；R03 / R21 体例略有不同，但 Specific Aims + Approach 的写作哲学完全适用。

## 1. 页数与版式硬性要求（PHS 398 / SF424 R&R）

NIH 标准 R01 申请的 Research Strategy 部分**最多 12 页**（不含 Specific Aims），常见结构：

| Section | 页数 | 用途 |
|---------|------|------|
| Specific Aims | **1 page** | 项目灵魂；多数评审先看这页决定是否往后读 |
| Research Strategy | 12 pages total | 含下列 3 个子 section |
| ├ Significance | ~2-3 pages | 为什么这个问题重要（"so what"） |
| ├ Innovation | ~0.5-1 page | 与现状相比有何新颖 |
| └ Approach | ~7-9 pages | 怎么做 + pitfalls + alternatives |
| Bibliography & References Cited | 不计页 | 引文 |
| Biosketch | **5 pages × 每位 key personnel** | PI / co-I 履历（详见 `prompts/pi-bio.md`） |
| Budget + Justification | 不计 | 见 `references/budget-international.md` |
| Resource Sharing Plan / Authentication of Key Resources | 各 ≤ 1 page | rigor & reproducibility 要求 |

### 1.1 字号 / 字体 / 间距 / 边距（违反一项即触发 system reject）

NIH 在 *Application Guide / NIAID 官方解读* 反复强调：

- **字体**：Arial / Helvetica / Palatino Linotype / Georgia 任选其一，**11 号或更大**（Symbol 字体仅用于希腊字母、特殊符号）
- **字色**：黑色（不要用灰色或浅蓝来"省页面"）
- **行距**：每英寸不超过 6 行（Word 中相当于 *Exactly 12pt*；不要 single-space 把字挤到 8 行/英寸）
- **字符密度**：每英寸不超过 15 个字符（即不要用 Arial Narrow 或人为压缩字间距）
- **页边距**：上下左右 **≥ 0.5 英寸**（推荐 0.5"，既合规又最大化篇幅）
- **页码 / PI 名**：**不得出现在页边距内**（系统打页码时会自动叠加，自行打的会被压在系统编号上）
- **图表**：可使用 ≥ 9 号字体（含 figure legend）

> 违规后果：eRA Commons 系统在 validation 阶段会自动检测部分项（页数 / 文件大小），但字号 / 行距由 reviewer 投诉触发"reject without review"——评审第一页发现 Arial Narrow 直接退稿。**永远用 Arial 11 + 0.5" margin 起草，不要"先写完再压版"**。

## 2. Specific Aims（最关键 1 页）—— 5 段黄金模板

NIH 评审有句口头禅："**The Specific Aims page is your proposal**"。一页通常 4-5 段。下面给出**最稳定的 5 段式黄金模板**——大多数被资助 R01 的 Aims page 都可以归约到这个结构。

### Para 1 — Hook + Significance + Knowledge Gap (4-7 sentences, ~1/4 page)

**目的**：让 reviewer 在 30 秒内回答两个问题：(a) 这是个真问题吗？(b) 我在乎吗？

```
[Hook 句] [疾病 / 现象的 magnitude，引一组震撼数字]
[Currently known 句 ×2-3] [the field knows ... + ... + ...]
[Critical gap 句]   However, [关键的 unknown，**用粗体或斜体强调**]
[Why gap matters 句] Filling this gap is critical because [短期临床/机制后果].
[Long-term goal 句] The long-term goal of our laboratory is to [PI 实验室 5-10 年抱负].
```

**写作要点**：

- 第 1 句**禁止从"X disease affects millions"开始**（陈词滥调）。改用 "Despite [advance], [outcome] remains [problem]" 这类**对比句**。
- 第 2-3 句的 "currently known" 必须有**具体引文**（[Smith 2023]）。
- "Critical gap" **必须粗体或斜体**——这是 reviewer 在 5 秒内定位 gap 的视觉锚。
- "Long-term goal" 不是本 R01 的目标，是 PI lab 的**愿景**——表明本 R01 是一个长期 program 的合理一步。

### Para 2 — Objective + Central Hypothesis + Rationale (3-5 sentences, ~1/4 page)

**目的**：把 long-term goal 收窄到**本 R01 的具体可检验命题**。

```
The objective of this proposal is to [本 R01 具体目标，1 句完成].
Our central hypothesis is that [新机制/新关系，**整页最重要的一句，必须粗体**].
The rationale for this hypothesis is supported by [preliminary data 1-2 项关键发现，引 Fig X].
```

**写作要点**：

- "Central hypothesis" 必须**可证伪**——能想象一个实验结果证明它错。"X regulates Y" 不够好；"X regulates Y by binding Z and increasing transcription of W" 才好。
- Rationale **必须援引 preliminary data**。NIH 评审最常见的 weakness 是 "hypothesis is speculative without preliminary support"。哪怕 R21 不强制 prelim，写一句"our pilot data suggest..." 也比纯思辨高分。
- 不要用 "We propose to study..."——这是 description，不是 hypothesis。

### Para 3 — Specific Aims 列表 (2-4 个 aims，每个 aim 3-5 行，约半页)

**每个 aim 段落 = aim title (动词) + working hypothesis + 一行方法 + 一行预期结果**：

```
Aim 1. [Determine / Test / Identify / Define / Characterize ...]
  Working hypothesis: [本 aim 的子假设，1 句].
  Approach: We will [方法 1-line], leveraging our [unique resource/preliminary data].
  Expected outcome: [预期产出 1 句，含 measurable endpoint].

Aim 2. [...]
  ...

Aim 3. [...]
  ...
```

**aims 关键原则**（NIH 评审"5 大致命伤"之一就是违反这些）：

1. **Aims 之间不能有"如果 Aim 1 失败，Aim 2 就垮"的串联依赖**（"contingent aims"）。三个 aims 必须可独立完成。
2. 每个 aim 应可独立产出 1-2 篇高质量论文。
3. **Aim 不要写成"Develop a tool"**——NIH 看中 *mechanistic insight*，不是 tool development。除非提案是 R21 instrument grant。
4. **Aim 标题用动词开头**（Determine / Test / Identify / Define / Quantify / Characterize）；**不要用 "Investigate" / "Study" / "Examine"**——这些动词不可证伪。
5. **3 个 aims 比 2 或 4 更安全**。2 个让 panel 觉得"野心不够支撑 5 年"；4 个让 panel 觉得"摊得太薄"。

### Para 4 — Innovation Summary + Expected Outcomes (2-4 sentences)

```
This proposal is innovative in [conceptual / methodological / translational] ways: 
[1-2 句具体说明 vs. specific comparator].
Expected outcomes include [a) ..., (b) ..., (c) ...].
```

### Para 5 — Impact (1-2 sentences)

```
Positive impact: this work will [transform field / inform clinical practice / open a new line of inquiry] by [具体机制].
```

> **整页 5 段共计 ~ 700-900 词**。如果你写到 1000+ 词，多半是 hook 太长——砍 Para 1 的描述性铺垫。

## 3. Significance（2-3 pages）—— 6 部分结构 + 必杀技

回答 "so what"。**结构化的 sub-headers 是高分本的标配**——飞机上读 30 份本子的 reviewer 看 sub-header 就能形成印象。

### 推荐结构

```
1. Magnitude of [疾病/现象]                                       (~0.5 page)
   - 流行病学数据 + 经济负担 + 未满足的临床需求
   - 用一张 figure 展示 disease burden 趋势

2. Current State of the Field                                    (~0.5 page)
   - what is known + what is NOT known
   - 引 5-10 篇近 5 年最相关文献，分小流派评述（不只是堆砌）

3. Critical Barriers to Progress                                 (~0.5 page)
   - 列出 2-3 个 specific barriers（**每个粗体**）
   - 不是空泛的 "more research is needed"

4. How This Project Addresses the Barriers                       (~0.5 page)
   - 把 Specific Aims 与 barriers 一一映射

5. Significance of Expected Outcomes                             (~0.3 page)
   - 临床 / 机制 / translational 三角度

6. Premature Truncation Avoidance                                (~0.2 page)
   - 一句话说明：这个 project 是 PI 长期 program 的合理一步，不会因为 grant 结束就停
```

### 必杀技：NIH-specific phrases that score

下列短语在被资助本中**反复出现**，是 reviewer 的"信号词"——会下意识加分。但**不能堆砌**，每段顶多 1-2 个：

- "**rigor and reproducibility**"（必出现，最佳出现在 Approach；NIH 自 2016 起强制评审项）
- "**premature truncation of [a research program / line of inquiry]**"（暗示"如果不资助，会损失什么"）
- "**leverages our preliminary data**"（强可行性）
- "**leverages the unique [cohort / model / dataset]**"（强独占性）
- "**trans-disciplinary** / **convergent science**"（多学科加分项，NIH Common Fund 喜欢）
- "**addresses an unmet clinical need**" / "**addresses a critical barrier**"
- "**sex as a biological variable (SABV)**"（合规必出现）
- "**authentication of key biological/chemical resources**"（合规必出现）
- "**informed by stakeholder input**"（health equity / community-engaged 加分）

**反例**（reviewer 一眼识破）：

- "This is a novel and important study" ——*novel* 是结论不是论据。
- "This research has tremendous potential" ——*tremendous* 在 NIH 评审里是空话。
- "We will establish a paradigm shift" ——只有 reviewer 有资格说 paradigm shift。

## 4. Innovation（约 0.5-1 page）

NIH 把 Innovation 单列一项评分。**至少声明一项**，最好 2-3 项：

| 类型 | 例 |
|------|---|
| **Conceptual innovation** | 新假设 / 新理论框架 / 重新定义已有概念 |
| **Methodological innovation** | 新技术 / 新工具 / 新算法 / 新数据源 |
| **Translational innovation** | 基础到临床的新桥梁 / 转化路径 |

### 反例（评审常给低分）

- "We will use CRISPR to..." ——CRISPR 已不是 innovation，是 standard tool（除非是 base editing / prime editing 等新衍生）
- "This is the first study to..." ——必须解释 *why first matters*；"first" 本身不是 innovation
- "We combine A and B" ——*combination* ≠ innovation 除非组合产生 emergent insight

### 正例

> "This proposal introduces a novel conceptual framework that integrates [A], [B], and [C] in a manner not previously attempted, supported by our preliminary data demonstrating [Fig 2]. Our methodological innovation lies in [specific technique advance over existing comparators], which provides 10× higher resolution than the current standard [cite]."

## 5. Approach（7-9 pages，篇幅最大）—— 每个 aim 5 件套

按 Specific Aims 顺序，每个 aim 一节。**每个 aim 必须包含 5 件套**（缺一件 reviewer 都会扣分）：

```
Aim 1. [aim title 与 Specific Aims page 一字不差]

  (1) Rationale (1 paragraph)
      - 为什么这么做 + 已有 preliminary data 概要
      - 引 Fig X 并解释 X 已经表明了什么、还没回答什么

  (2) Experimental Design / Analytical Plan
      Sub-aim 1.1: [具体子目标]
      - 模型 / 样本 / cohort / 数据
      - Sample size + power analysis（具体到 effect size）
      - 统计方法（含多重比较校正、缺失值处理）
      - 时间安排
      Sub-aim 1.2: ...

  (3) Expected Results (1 paragraph)
      - 量化预期 + 与 hypothesis 的连接

  (4) Potential Pitfalls and Alternative Strategies (1 paragraph)
      - Pitfall: 如果 X 出现这种情况
      - Alternative: 我们将采用 Y 替代（必须 feasible，最好引一篇 PI 自己的 prior work）

  (5) Rigor and Reproducibility (1 paragraph)
      - Authentication of key resources（cell line STR + antibody validation lot）
      - Sex as a biological variable
      - Blinding / randomization / pre-registration（如适用）
      - Data and code sharing plan
```

### Approach 高频踩雷点

1. **缺少 power analysis / sample size justification**——每个量化实验都要写 expected effect size + α + 1-β + n（reviewer 最爱挑这个刺）。
2. **缺少 sex as a biological variable**——NIH 自 2016 强制要求；如果只用一种性别，必须**充分论证**（not "mice are too aggressive"）。
3. **缺少 alternative strategies**——评审最常诟病的话："the authors have apparently not considered the possibility of failure"。
4. **统计方法过于简单**——只写 "Student's t-test" 是死亡信号。要明示：多重比较 (Bonferroni / FDR / Tukey HSD)、纵向数据 (mixed models / GEE)、生存数据 (Cox PH)、聚类标准误等。
5. **缺少 rigor & reproducibility 段落**——authentication of key resources / blinding / data sharing plan 必须明示。
6. **Aim 1 过 elaborate，Aim 3 草草收尾**——reviewer 一眼看出"作者没真想清楚 Aim 3"，整本扣分。

### 必备图表

NIH 高分本几乎都有：

- **Conceptual model figure**（Significance 末尾，1 张）
- **Preliminary data figures**（散布在 Significance + Approach，3-6 张，每张 ≤ 半页）
- **Experimental design schematic**（每个 aim 1 张，flow chart 形式）
- **Timeline / Gantt chart**（Approach 末尾，1 张）

## 6. Preliminary Data 的分布与写法

通常**散布在 Significance 和 Approach** 中，不单列。每段 preliminary data 必须含：

- Figure / panel 引用（"Fig 1A shows..."）
- Methods 简述（n = X, statistical test used）
- Conclusion（**用粗体一句话**：*"These data suggest that X regulates Y."*）
- Connection 到对应的 specific aim（"This finding directly motivates Aim 2."）

> 写 R01 但 prelim 不够？建议先申 R21（不强制 prelim）或 R03（小项目）做出 prelim 再上 R01。强行用"will be completed in Year 1 of the proposed project"代替 prelim 是死亡信号。

## 7. NIH 评分体系（2025 起新框架 vs 旧框架）

### 7.1 旧框架（2024 及以前；理解历史用）

每位 reviewer 给 1-9 分（1 最优）：

| Criterion | 权重提示 |
|-----------|---------|
| Significance | 高 |
| Investigator(s) | 中（看 biosketch） |
| Innovation | 高 |
| Approach | **最高**（4 项里最重） |
| Environment | 一般不卡 |

### 7.2 简化框架（2025 年 1 月 25 日起新申请适用）

NIH 把 5 项重组为 **3 个 Factor**（NOT-OD-24-010）：

| Factor | 含原 criteria | 评分 |
|--------|--------------|------|
| **Factor 1: Importance of the Research** | Significance + Innovation | 1-9 数值评分 |
| **Factor 2: Rigor and Feasibility** | Approach | 1-9 数值评分 |
| **Factor 3: Expertise and Resources** | Investigator + Environment | **仅 "sufficient" / "need to address"**，不数值评分 |

> 写作影响：Approach 不再被独立 4 项之一，而是几乎独占 Factor 2。**Approach 部分写得严谨直接决定 Factor 2 分数**。

### 7.3 Overall Impact Score 与 percentile

- **Overall Impact Score** = round(reviewer scores 平均 × 10) → 范围 10-90，10 最佳
- **Percentile** = 该 study section 最近 3 次会议的相对排位（1-99，越低越好）
- **Triage threshold**：bottom ~50% 不进入 panel discussion（"streamlined"，无 percentile，但仍有 summary statement）
- 经验数值：**impact score ≤ 30** 通常 fundable；31-45 borderline（取决于 IC 和 ESI status）；≥ 46 几乎不可能

### 7.4 各 IC 的 Payline（2024-2025 实际数字，以官方当年公告为准）

| IC | FY 2024-25 R01 payline (established PI) | ESI Payline |
|----|----------------------------------------|-------------|
| NIAID | ~8 percentile | ~12 percentile |
| NIDDK | ~16 percentile（top 16% 几乎全资助）| 通常 +4 |
| NINDS | ~14 percentile | 通常 +4 |
| NCI | 通常较低（< 10 percentile） | 通常 +4 |
| NIGMS | 不用 percentile，用 priority score（cutoff 因 program 而异） |  |

> **要点**：Payline 是"几乎一定资助"线。Above payline 还有 selective pay（NIH 称 "high-program-priority"）。每年 fiscal year 数字不同，**以本 IC 当年官网公告为准**。

## 8. Resubmission 策略

R01 通常需要 1-2 次 resubmit。Resubmission 必含 **Introduction to Resubmission (1 page)**：

- 逐条回应 prior reviewers' critiques（**必须 verbatim 引用 critique**，再答复）
- 用 **bold** / **italic** / **track changes** / 左侧 vertical bar 标识本次修改的位置
- **不要争辩；要认错并展示改进**——"We thank the reviewer and have addressed this concern by..." 比 "The reviewer misunderstood..." 高分得多
- 如果一定要坚持原方案，提供**新数据**支持（不是新论证）

> 注意：自 2014 起 NIH 取消了"A2"——只能 resubmit 1 次（A1）；A1 不中后只能"new application"重新开始（不能引用 A0/A1）。但 reviewer 还是能查到，所以 substantively 仍要不同。

## 9. 中国 PI 申请 R01 的现实路径

- 中国境内 PI **单独**申请 R01 极少；常见路径：
  1. **美方 PI 主导 + 中国 collaborator subaward**（最常见）
  2. **PI 在美机构有 secondary appointment** 作为 contact PI 申请 multiple-PI plan
  3. **U.S.-China Collaborative Biomedical Research Program (NIH-NSFC 合作)**——双边联合资助，但近年活跃度下降
- **NIH 资金不可直接资助"非美方实体进行的研究"**，subaward 比例需谨慎；近年对涉外合作合规审查更严：
  - **Other Support / foreign component disclosure**：所有海外项目（含 NSFC、社科基金）必须披露；漏报可导致项目撤销
  - **NIH Foreign Component**：在美国之外进行的 substantive scientific contribution 必须在 cover letter + Other Support 显式标注
  - **Multiple-PI plan**：必须详述 PI 间的 leadership / decision-making / conflict-resolution 流程

## 10. 自检 Checklist（提交前最后一遍）

- [ ] Specific Aims 1 页内？字号 Arial 11+，行距 ≤ 6 行/英寸，边距 ≥ 0.5"
- [ ] Specific Aims 含 5 段：Hook+Gap / Hypothesis+Rationale / Aims / Innovation / Impact
- [ ] **Central hypothesis** 是粗体且可证伪？
- [ ] 3 个 aims 互不依赖？每个 aim 都有 working hypothesis？
- [ ] Significance 含 6 部分 sub-header？每个 critical barrier 与 aim 一一映射？
- [ ] Innovation 显式声明类型（conceptual/methodological/translational）+ specific comparator？
- [ ] 每个 aim 含 5 件套（rationale / design / expected / pitfalls / rigor）？
- [ ] Sex as biological variable 在 Approach 明示？
- [ ] Authentication of key resources 单列附件 ≤ 1 页？
- [ ] Resource sharing plan / Data management & sharing plan（DMS Plan，2023 起强制）已附？
- [ ] Biosketch 5 页内 + Personal Statement 与本提案 explicit fit？
- [ ] Other Support 列出**所有**在研 + 申报中的中国资助？
- [ ] 没有任何中文期刊只列 abbrev（必须全名 + 英译题目）？
