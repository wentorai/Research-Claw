# 1-Page Specific Aims Prompt（NIH R01 灵魂 1 页）

> NIH R01 / R21 / R03 申请书的 Specific Aims 是 study section reviewer **triage 决策的关键页面**。~50% 申请被 Not Discussed (ND)，触发 ND 的最常见原因不是 Approach 写得差，而是**Aims 页 60 秒内未抓住 reviewer**。本 prompt 给出"4 段黄金结构"+ 5 类 hook 句式 + 4 类 hypothesis 句式 + worked example，配合 `references/real-examples.md`、`references/nih-r01.md`、`references/reviewer-psychology.md` 联用。

## 何时调用

当用户准备 NIH R01 / R21 / R03 / NHLBI / NIDDK / NCI / NIA / NIMH 等 NIH 旗下 institute 资助的 1-page Specific Aims 时。也适用于：
- DoD / CDMRP 同样的 1-page Aims 体例；
- 部分私人基金会（HHMI, Damon Runyon, BWF）的 narrative；
- ERC Step 2 extended proposal 的"3 specific objectives"段（结构相似，措辞需调整）。

## 输入要求

请在调用前准备好以下信息（**用具体描述，禁用 X/Y/Z 占位符**）：

1. **研究领域具体一段**（如"乳腺癌免疫治疗中的 T 细胞耗竭"，不要写成"癌症免疫学"）；
2. **拟解决的临床 / 科学问题**（1 句，必须是可证伪的命题，而非"研究 X 的影响"）；
3. **关键 preliminary data**（最重要的 2-3 个发现 + 数字 + 图编号）；
4. **Long-term goal**（你 lab 的 5-10 年方向，1 句）；
5. **3 个 specific aims 的粗版本**（动词 + 对象，不需要完整描述，AI 会精化）；
6. **目标 institute 与 RFA**（决定 Innovation 段如何对齐战略优先级）；
7. **PI 是否 ESI (Early Stage Investigator)** —— 影响 hook 选择（ESI 更需要 preliminary-data-driven hook）。

## 4 段黄金结构（NIH 通用范式）

每段长度严格控制——4 段总字数应在 600-800 字（11pt Arial 单倍行距 + 1 张 Fig. 1 占 ~1/3 页）。

---

### Para 1 — Hook（4-6 句）

**功能**：60 秒抓住 reviewer 注意，建立"why now / why important / why not yet solved"。

**必含 5 个元素**（顺序灵活，但必须全部覆盖）：

1. **第一句**：临床 / 社会问题的 magnitude（**数字化**：发病率 / 死亡率 / 经济成本 / 患者数 / 5 年生存率）；
2. **第二句**：当前 standard of care 的局限（具体到响应率 / 副作用率 / 治疗缺口）；
3. **第三句**：**knowledge gap**——为什么现有研究还没解决（"the molecular drivers... remain elusive" / "the temporal dynamics... are unresolved"）；
4. **第四句**：**critical barrier** 这一 gap 不解决，下一步进展受阻；
5. **第五句**：**long-term goal** of our lab + **objective of this proposal**（短期目标，1 句直击 Aims）。

#### 5 类 Hook 句式（带真实领域具体短语，**不用 X/Y/Z**）

##### 类型 1：流行病学钩子（人群级问题）

> "Breast cancer remains the leading cause of cancer death in women under 60, with triple-negative breast cancer accounting for 15-20% of cases and a 5-year metastatic survival below 30%."

适用场景：肿瘤、心血管、神经退行、传染病、代谢病等高发疾病。

##### 类型 2：治疗缺口钩子（therapy gap）

> "Despite the success of immune checkpoint inhibitors in melanoma, response rates in TNBC remain below 15% (KEYNOTE-355), leaving the majority of patients without a durable response."

适用场景：现有疗法存在但效果有限，本课题旨在弥补缺口。

##### 类型 3：机制悖论钩子（paradox / unresolved mechanism）

> "While T-cell exhaustion is widely recognized as a barrier to anti-tumor immunity in chronic viral infection, its molecular drivers in solid tumors remain elusive—with conflicting reports on the role of TCF7 vs. TOX as master regulators."

适用场景：基础机制研究、生物学谜题。

##### 类型 4：突破点钩子（recent breakthrough creates opportunity）

> "Recent CRISPR-based functional genomics screens have identified TCF7 as a master regulator of stem-like CD8 T cells (Chen et al., Cell 2022), but its therapeutic potential as a druggable target in solid tumors is unexplored."

适用场景：领域里刚出现新工具 / 新发现，本课题做"first to translate" 类工作。

##### 类型 5：数据先导钩子（preliminary-data-driven, ESI 推荐）

> "Our preliminary data show 40% improvement in tumor regression when combining anti-PD-1 with [novel TCF7-reactivating agent] in 4T1 (Fig. 1), suggesting that targeting the epigenetic silencing of *Tcf7* may overcome anti-PD-1 resistance in TNBC."

适用场景：ESI 或拥有 striking preliminary data 的 PI；将 Fig. 1 提前到第一段以建立可信度。

---

### Para 2 — Central Hypothesis + Preliminary Data（3-4 句）

**功能**：把 Para 1 的"问题"转成"我们的具体可证伪命题"。

**核心句式**：
> "Our central hypothesis is that **[specific molecular / mechanistic claim with predicted direction]**; we will test this hypothesis by **[brief description of approach]**, leveraging **[1-2 sentence preliminary data]**."

#### 4 类 hypothesis 句式（每类 1 个真实领域示例）

##### 类型 A：Mechanism-driven（机制假设）

> "Our central hypothesis is that epigenetic silencing of the *Tcf7* locus by DNMT3A is the proximate driver of terminal CD8 T-cell exhaustion in TNBC, and that pharmacologic DNMT3A inhibition combined with anti-PD-1 will restore durable anti-tumor immunity."

特点：1 个分子 + 1 个具体酶/路径 + 可预测的干预结果。

##### 类型 B：Nested hypothesis（嵌套假设）

> "Our central hypothesis is that microglial TREM2 signaling is *protective* during a defined mid-stage window when microglia retain phagocytic capacity, but *pathogenic* at late stage when chronic activation drives synapse loss; consequently, TREM2 agonism will be efficacious only within this temporal window."

特点：含**条件分支**（windowed effect / state-dependent）；适合"重新定义已有靶点"类研究。

##### 类型 C：Data-driven hypothesis（数据驱动）

> "Our central hypothesis is that an SE(3)-equivariant geometric neural network, trained with interface-aware contrastive learning, can generalize across PPI families to achieve experimentally confirmed hit rates ≥ 10%, an order-of-magnitude improvement over docking-based methods."

特点：可量化预测（hit rate ≥ 10%）；适合 AI/ML / 计算研究。

##### 类型 D：Action-oriented hypothesis（干预导向）

> "Our central hypothesis is that combining low-dose decitabine with anti-PD-1 will reactivate stem-like CD8 progenitors in immunotherapy-resistant TNBC, achieving ≥ 50% complete tumor regression in syngeneic models."

特点：直接以"治疗效果"作为 hypothesis 主体；适合 translational R01。

#### Preliminary data 整合规则

- **必须有 1 张 Fig. 1**（占 1/3 页面，多 panel: A/B/C）；
- 在 Para 2 末尾用 **3 个数字句**描述（如范例 1 的 "(i) 4-fold depletion ... (ii) ATAC-seq reveals ... (iii) 38% complete regression"）；
- ESI 把 Fig. 1 移到 Para 1 末尾（因 ESI 缺 track record，preliminary data 是唯一可信度来源）。

---

### Para 3 — Specific Aims（标题 + 子描述 × 3）

#### Aim 标题写作规则

- **Strong action verb 开头**（**Determine / Define / Establish / Identify / Test / Map / Resolve**）——避免 *Study / Investigate / Explore / Examine*；
- **≤ 25 词**；
- **必含 outcome**（"... that achieves X" / "... in Y model"）。

**示例**：
- ✅ "**Aim 1. Determine the epigenetic mechanism of *Tcf7* silencing in TNBC-infiltrating CD8 T cells.**"
- ❌ "Study Tcf7 in T cells"

#### Aim 子描述规则（4-6 句 / aim）

每个 Aim 的子描述必须包含：

1. **Sub-hypothesis** （1 句，比 central hypothesis 更具体）；
2. **Approach**（1-2 句，主要技术 + 模型 + 样本量）；
3. **Expected outcome**（1 句，**可量化**，如 "AUROC ≥ 0.85"）；
4. **Alternative strategy**（1 句，"if X fails, we will pursue Y"）。

#### 3 个 Aim 必须"独立但互锁"（critical reviewer test）

- **独立**：Aim 1 的实验失败不应让 Aim 2/3 全死——避免线性依赖（target → validation → drug）；
- **互锁**：3 个 Aim 共同支撑 central hypothesis，不互相重复或冗余；
- **类型组合**（推荐）：Aim 1 = mechanism / discovery；Aim 2 = in vivo validation；Aim 3 = translational / biomarker / human-relevance。

---

### Para 4 — Innovation + Impact（3-4 句）

**功能**：直接告诉 reviewer "为什么这是 paradigm-shift 而不是 incremental"。

#### 4 句模板

1. **第一句**："This proposal is innovative because **[3 specific points]**: (1) novel target / mechanism; (2) novel method / model; (3) novel application / population."
2. **第二句**："Successfully completing this work will **[concrete deliverable: a tool / a biomarker / a drug lead / a framework]**."
3. **第三句**："The expected outcome will fundamentally advance **[field-level impact]**."
4. **第四句（可选但推荐）**："This work directly aligns with **[NIH institute] [Strategic Plan / RFA] priority of [specific theme]**."

**示例**（来自范例 1）：

> "This proposal is innovative because (1) it pivots from blocking exhaustion to *reversing* it through epigenetic reprogramming, (2) it leverages a clinically advanced DNMT3A inhibitor, shortening translation, and (3) it integrates patient-derived methylation biomarkers for prospective stratification. Successfully completing this work will identify the first epigenetic combination strategy for anti-PD-1-refractory TNBC and define a generalizable framework for restoring stem-like T-cell function in solid tumors. This work directly aligns with NCI's *Cancer Moonshot* priority of overcoming immunotherapy resistance."

## 排版规范（NIH 强制 + reviewer 心理）

- **字号**：11pt Arial / Helvetica / Palatino Linotype（推荐 Arial）；
- **行距**：单倍（1.0）；
- **页边距**：≥ 0.5 inch（建议 1 inch 左右；NIH 要求 ≥ 0.5）；
- **图**：1 张 preliminary data figure，~1/3 页；标 "**Figure 1**" 加粗；
- **Aim 标题**：**加粗 + 下划线**；子描述正常字体；
- **段间距**：6pt（NIH 推荐）；
- **Long-term goal / objective / central hypothesis** 三个关键短语**全文加粗**——reviewer 在 30 秒扫读时可定位。

## Self-Check 清单（reviewer 一定会问的 5 个问题）

写完 Aims 页后，逐条 check（**全部 ✅ 才能投**）：

1. ✅ **"So what?" 测试**：如果整页只看 Para 1，能否让 reviewer 30 秒明白"为什么应该资助这个 R01 而不是另外 100 份"？
2. ✅ **"Aim independence" 测试**：Aim 1 的核心假设错了，Aim 2 是否还能继续？Aim 2 失败了，Aim 3 是否还有意义？
3. ✅ **"Sticky notes" 测试**：把每个 Aim 的标题写在便签上，能否一眼看出 3 者的逻辑关系（discovery → validation → translation 或 mechanism × scale × disease）？
4. ✅ **"Innovation rated 3" 测试**：Innovation 段是否能给出至少 1 个 paradigm-shift 的点？（不仅是"我们用了新方法做老问题"——那是 Approach，不是 Innovation。）
5. ✅ **"Preliminary data 充分性" 测试**：Aim 1 至少有 1 个 Fig. 1 panel 直接支撑；Aim 2/3 至少在 Approach 章节有 preliminary data。

## 进阶要点

### NIH Rigor & Reproducibility (R&R) 4 项

NIH 要求 Approach 章节体现：
1. **Authentication** of key biological / chemical resources（细胞系 / 抗体 / 化合物来源与验证）；
2. **Sex as a biological variable** (SABV)（在动物 / 人体研究中说明性别均衡或 justify single-sex）；
3. **Sample size justification**（power analysis）；
4. **Blinding & randomization**。

**Aims 页不需展开**，但可以在 Innovation 段轻描一句："with rigorous experimental design including sex-balanced cohorts, pre-registered analytical plans, and blinded endpoint assessments."

### NIH Resubmission (A1) 时的 Aims 调整

A1 阶段 Aims 通常**保持原版 ~80%，修改 ~20%**：
- 在 Para 1 末尾加 1 句"In response to the previous review, we have [strengthened preliminary data / refined Aim X / added alternative Y]."
- 不能完全重写——reviewer 一致性会判"PI 没有方向感"。

### 写完后的 30 秒口头测试

找 1 位 senior 同事（最好不在你具体细分方向的）读 Aims 页 30 秒，关掉文件后让他/她回答：
1. **What's the disease / problem?**
2. **What's the central hypothesis?**
3. **What are the 3 aims (in plain English)?**

任何一项答不出 → 那一段重写。这是 NIH 写作圈的"Brown bag 测试"，是把"我觉得清楚"变成"reviewer 觉得清楚"的唯一可靠方法。

---

## 1 个完整 Worked Example

以下是按本 prompt 全部规则写成的 1 整页 Specific Aims（hypothetical, illustrative only），目标 R01 / NCI。

---

**Title**: Reprogramming Exhausted CD8 T Cells in Triple-Negative Breast Cancer via Epigenetic TCF7 Reactivation

Triple-negative breast cancer (TNBC) accounts for 15–20% of all breast cancers and remains the deadliest subtype, with a 5-year metastatic survival below 30% (Bianchini et al., *Nat Rev Clin Oncol* 2022). Although immune checkpoint inhibitors (anti-PD-1) have transformed melanoma and NSCLC outcomes, **objective response rates in metastatic TNBC remain below 15%** (KEYNOTE-355). The dominant resistance mechanism is intratumoral CD8 T-cell exhaustion, but the molecular drivers that lock TNBC-infiltrating T cells into terminal exhaustion remain elusive—a critical barrier to durable immunotherapy. **Our long-term goal** is to develop precision combination immunotherapies that restore stem-like T-cell function in solid tumors. **The objective of this proposal** is to define the role of TCF7 as a master regulator of stem-like CD8 T cells in TNBC and to establish epigenetic TCF7 reactivation as a therapeutically tractable strategy.

Our preliminary data show that (i) TCF7⁺PD-1ᵢⁿᵗ progenitors are 4-fold depleted in anti-PD-1-resistant 4T1 tumors (Fig. 1A); (ii) ATAC-seq reveals selective loss of chromatin accessibility at the *Tcf7* locus (Fig. 1B); and (iii) lentiviral *Tcf7* re-expression restores anti-PD-1 sensitivity (38% vs 6% complete regression, Fig. 1C, n=12, p<0.01). **Our central hypothesis is that DNMT3A-mediated CpG methylation silences *Tcf7* in TNBC-infiltrating CD8 T cells, and that pharmacologic DNMT3A inhibition combined with anti-PD-1 will restore durable anti-tumor immunity.**

**<u>Aim 1. Determine the epigenetic mechanism of *Tcf7* silencing in TNBC-infiltrating CD8 T cells.</u>** Using paired single-cell ATAC-seq + RNA-seq on sorted PD-1⁺ CD8 T cells from 4T1 and humanized PDX models, we will test whether DNMT3A is necessary and sufficient for TCF7 loss. Expected outcome: identification of DNMT3A-dependent CpG methylation as the upstream event. Alternative: if DNMT3A is dispensable, we will pursue G9a/EZH2 (preliminary support, Fig. 2).

**<u>Aim 2. Establish in vivo therapeutic efficacy of DNMT3A inhibition combined with anti-PD-1.</u>** We will test the clinically advanced DNMT3A inhibitor [compound X] in 3 syngeneic TNBC models. Expected outcome: ≥ 50% complete regression at clinically achievable doses with restored TCF7⁺ progenitors. Toxicity will be assessed in parallel.

**<u>Aim 3. Identify TNBC patients most likely to benefit via biomarker-guided stratification.</u>** Using a 60-patient archived neoadjuvant anti-PD-1 trial cohort, we will profile baseline tumor TCF7-locus methylation. Expected outcome: a methylation signature predicting response (AUC ≥ 0.80) and a go/no-go threshold for a future Phase Ib trial.

**This proposal is innovative because** (1) it pivots from blocking to reversing exhaustion through epigenetic reprogramming, (2) it leverages a clinically advanced DNMT3A inhibitor with a short translation path, and (3) it integrates patient-derived methylation biomarkers for prospective stratification. **Successfully completing this work** will identify the first epigenetic combination strategy for anti-PD-1-refractory TNBC and define a generalizable framework for restoring stem-like T-cell function in solid tumors. **This work directly aligns** with NCI's *Cancer Moonshot* priority of overcoming immunotherapy resistance.

---

## 联用建议

- 写完 Aims 页 → 立即跑 `references/real-examples.md` 中 5 项排版与 Self-Check 清单；
- 评审心理盲区 → `references/reviewer-psychology.md` 第一节（NIH triage 50% ND 机制）；
- Approach 章节展开 → `prompts/approach.md`；
- Innovation 章节延伸 → `prompts/innovation.md`；
- Significance 章节扩写 → `prompts/significance.md`；
- Biosketch + Personal Statement → `prompts/pi-bio.md`。
