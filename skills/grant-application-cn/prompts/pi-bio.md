# Prompt: 个人简介 / Biosketch / Track Record / Personal Statement 撰写

## 用途

帮助用户撰写各类项目的"PI / 团队介绍"段落。**不同体例差异极大**：NIH 5-page biosketch + Personal Statement 与 ERC 2-page CV + 2-page Track Record + 国家社科"申请人 5 年代表作"完全不同。本 prompt 自动适配。

> 关键认识：在 PI 资历相近的两份本子之间，**Personal Statement / Track Record 的 30 秒电梯演讲质量**往往决定 panel 印象。这一节是"PI 包装"而非简历翻译。

## 项目体例映射

| 项目 | 文件 / 段落 | 篇幅指引 |
|------|------------|---------|
| 国家社科 / 教育部 | "课题负责人主要研究专长 + 学术简历 + 已发表成果（限近 5 年）" + "课题组成员简介" | 占活页约 1/4 |
| NSFC（互补 Skill） | "研究基础与工作条件" + 个人简历表 | 1-2 页 |
| **NIH** | **Biosketch (Common Form, 2026 起)** — Personal Statement + Positions / Honors + Contributions to Science | **5 pages each per key personnel** |
| **NSF** | **Biographical Sketch** — Identifying Info + Professional Preparation + Appointments + Products + Synergistic Activities | **3 pages each, 必须用 SciENcv 生成** |
| **ERC** | Part B1 PI CV + Track Record | **2 pages CV + 2 pages Track Record** |
| MSCA PF | Researcher CV + Supervisor CV (in B1) | 视当年模板 |

## 输入要求

询问用户：

1. **目标项目类型**
2. **PI 学历 + 工作经历**（按时间倒序）
3. **代表作 5-10 篇**（含 DOI / 完整引文）
4. **主持过的资助 / 奖项 / 学会职务**
5. **培养博士生 / 博士后情况**（NIH/NSF/ERC 关心，国家社科较少关心）
6. **本研究方向上的最相关 3 篇产出**（用于 contributions to science / track record 的代表段）
7. **PI 在该方向上的"独立贡献"**（vs supervisor / postdoc PI 的工作）

## 体例特化输出模板

### NIH Biographical Sketch 5-page 详细模板（2026+ Common Form 版）

> 2026 年 1 月 25 日起所有 due date 适用 Common Forms。下面给出**详细 4 节模板**（旧版 Section D 已取消）。

```
NAME: [Last, First Middle]
eRA COMMONS USER NAME: [if applicable]
POSITION TITLE: [职务]

EDUCATION/TRAINING (Begin with baccalaureate or other initial professional education)
| INSTITUTION              | DEGREE | Completion Date (MM/YYYY) | FIELD OF STUDY |
| ...                      | ...    | ...                      | ...            |

────────────────────────────────────────────────
A. Personal Statement                            [~ 0.5-1 page; ≤ 3,500 chars]
────────────────────────────────────────────────

[第 1 段 — "30 秒电梯演讲"]
[1 句：PI 在领域中的位置 + 与本提案的独特 fit]
[1 句：why uniquely qualified to lead this project]
[1 句：本提案如何契合 PI 长期 trajectory]

[第 2 段 — Most Relevant Contributions]
列举 3-5 项最相关的产出（用 publication numbering 与 Section C 对应；
不要照搬 C 段的描述，应聚焦"与本提案 alignment"）：
1. [代表作 1] — established [foundational finding] that motivates Aim 1 of this proposal.
2. [代表作 2] — developed [methodological tool] that will be applied in Aim 2.
3. [代表作 3] — provided preliminary data shown in Fig X.

[第 3 段 — Ongoing & Completed Projects 与本提案的衔接]
- [Active grant Y]: relationship — complementary scope; no overlap because [...]
- [Completed grant Z]: produced the preliminary data in Fig X.
（不与 Other Support 重复，但可呼应；最重要的是显式说明 no overlap）

────────────────────────────────────────────────
B. Positions, Scientific Appointments, and Honors  [~ 0.5-1 page]
────────────────────────────────────────────────

Positions and Scientific Appointments
- 倒序列出 (年-年: title, institution, department)
- 仅含 ≥ 6 months 任职

Honors / Awards
- 仅列国际级 / 学术学会级 / 国家级（不要列校内 / 院系级）
- 倒序，年: name, awarding body
- ≤ 10 项

────────────────────────────────────────────────
C. Contributions to Science                       [~ 2-3 pages]
────────────────────────────────────────────────

[列 3-5 个 "contribution" 主题]

(1) [主题 1 — 用一个 substantive 的句子陈述贡献，不只是 topic]
    Example title: "Establishing the role of [X] in [Y]"

    [1 段说明：(a) 主题背景；(b) PI 的具体贡献，**显式区分独立贡献 vs 团队 / supervisor 贡献**；
    (c) 领域影响 — independent assessments, citations, awards]

    Representative publications (≤ 4):
    a. [完整引文 + DOI]. PMCID: ...
    b. ...
    c. ...
    d. ...

(2) [主题 2 ...]
    ...

(3) [主题 3 ...]
    ...

注：不要堆叠 50 篇文章；选择能讲故事的代表作。优先 senior author / 通讯作者的 paper。

完整 publications 列表 URL（My Bibliography）: https://www.ncbi.nlm.nih.gov/myncbi/...

────────────────────────────────────────────────
（Section D Scholastic Performance 已于 2024 年取消）
```

### NIH Personal Statement 第 1 段"30 秒电梯演讲"模板

NIH 评审看 biosketch 时第一眼读 Personal Statement——这一段需要 30 秒钩住 reviewer。**3 句话固定模板**：

```
Sentence 1 (PI 定位): "I am a [职务] at [机构] with [N] years of expertise 
in [研究领域 + sub-area]."

Sentence 2 (Unique fit): "My laboratory has [unique capability — cohort / 
model / method / dataset] and has published [N] papers establishing 
[foundational contribution] in this area."

Sentence 3 (本提案 fit): "I am uniquely positioned to lead this proposal 
because [specific element — preliminary data / unique resource / track record 
of mentorship if K award / collaboration network]."
```

**例**：
> *I am an Associate Professor of Cancer Biology at [Institution] with 12 years of expertise in tumor immunology and immunotherapy resistance. My laboratory established the role of [X] as a determinant of CD8+ T cell exclusion (3 senior-author papers in Cell, Nature Cancer, Cancer Discovery) and developed a panel of 12 patient-derived xenograft models of resistant TNBC currently in use by 4 collaborator labs. I am uniquely positioned to lead this proposal: our preliminary data establish [A] as a novel resistance regulator (Fig 1), our PDX panel enables in vivo testing in Aim 2, and my prior K22 → R01 trajectory demonstrates the productivity to deliver on a 5-year program.*

### NSF Biographical Sketch（3 pages，必须用 SciENcv 生成 PDF）

```
1. Identifying Information: name, ORCID, position, department

2. Professional Preparation
   [Institution] — [Major] — [Degree, Year]
   (倒序，PhD 在前)

3. Appointments and Positions  
   (倒序：年-年: title, institution)

4. Products
   - Up to 5 publications most closely related to the proposed project
   - Up to 5 other significant publications
   （含 DOI / preprint URL；非论文产出可包括 datasets / patents / curricula）

5. Synergistic Activities (≤ 5 examples)
   每条 1-2 行，不超过 1 页总长。每条要含:
   - 名称 / 时间 / 角色
   - 受众 / 影响数字（# students reached, # papers cited as case study）
   
   高分例:
   • Co-developed Open Source Curriculum "X" (2022-now); deployed at 12 universities, 
     ~600 students/yr; recognized by [society award].
   • External evaluator for [program]; trained 4 cohorts (n = 80) of REU students 
     from underrepresented groups; tracked 5-yr graduate enrollment.
```

### ERC Part B1 — PI CV (≤ 2 pages) + Track Record (≤ 2 pages)

参见 `references/erc-cv-and-track-record.md` 完整模板。要点回顾：

```
CV (≤ 2 pages):
PERSONAL INFO / EDUCATION / CURRENT & PREVIOUS POSITIONS / 
FELLOWSHIPS & AWARDS / SUPERVISION OF GRADUATES & POSTDOCS / 
TEACHING / ORGANISATION OF SCIENTIFIC MEETINGS / INSTITUTIONAL 
RESPONSIBILITIES / REVIEWING ACTIVITIES / MEMBERSHIPS / 
MAJOR COLLABORATIONS

Track Record (≤ 2 pages):
- 按主题分组（3 大方向）展示贡献，每组 5-10 篇代表作
- 区分 first author（学生 / 博士后）vs senior/corresponding author（独立 PI）
- INVITED CONTRIBUTIONS / KEYNOTES
- PRIZES, AWARDS, ACADEMIES
- FUNDING ID
```

### 国家社科 / 教育部体例（活页要求）

```
课题负责人主要研究专长（500-800 字）
- 学科方向 + 已积累的核心问题
- 与本课题的延续关系
- **绝对匿名**：不出现"本人""我""我们课题组"等

学术简历（按时间倒序）
- 教育经历
- 工作经历
- 学术职务（学会 / 期刊审稿）

近 5 年已发表成果（与课题相关，限 10 项）
- 论文：作者. 题目. 期刊, 年, 卷(期): 页
- 著作：作者. 书名. 出版社, 年
- 注：活页阶段不写"我们"等暴露身份的语言
- 注：连续 ≥ 3 篇为申请人著作 → 暴露风险 → 适当稀释

主要参加者简介（每人 ≤ 200 字）
- 姓名 / 性别 / 出生年 / 职称 / 工作单位 / 研究专长 + 与本课题的分工
```

## ERC PI section 区别于 NIH 的 4 个点

很多 PI 第一次申 ERC 时直接把 NIH biosketch 翻译过来——**这通常导致 Step 1 即被淘汰**。两者根本差异：

### 区别 1: ERC 关心 "ground-breaking nature"，NIH 关心 "rigor & feasibility"

- **NIH biosketch**：Contributions to Science 用于证明 "PI 能可靠完成提议的研究"
- **ERC Track Record**：用于证明 "PI 已经在做 ground-breaking 工作，并且即将做得更 ground-breaking"

写作差异：
- NIH 例：*"This work demonstrated the feasibility of [method] in [model]."*（重 feasibility）
- ERC 例：*"This work established a new conceptual framework that has been adopted as the standard in [field]."*（重 transformative）

### 区别 2: ERC 强调 "research independence"，NIH 不强求

- ERC StG/CoG 评审会**显式问**："is this candidate's work independent of supervisor / postdoc PI?"
- 必须显式区分 first-author（学生 / 博士后阶段）vs senior/corresponding author（独立 PI 阶段）
- 国内学者常踩的雷：把 supervisor 的工作算进自己 track record——ERC panel 会查 PubMed 作者次序，露馅就是 fatal

### 区别 3: ERC Track Record 按"主题分组"，NIH Section C 也分组但更 free-form

- ERC: **强制 3 主题 × 4-6 篇**结构，每主题第 1 句必须是"contribution sentence"
- NIH Section C: 3-5 主题，每个主题更长描述 + 4 篇代表作；独立性不是核心维度

### 区别 4: ERC 评审会做"interview"，NIH 不做

- ERC Step 2 包含 10-min in-person presentation + 15-min Q&A
- 因此 Track Record 写作时已要预想 Q&A：哪一篇是最 ground-breaking？为什么？
- NIH 完全 desk review，无 oral defense

## 重要写作要点

### 1. 国际项目的"国际可读性"

中国 PI 常踩的雷：

- 中文期刊只写英文译名 + 期刊全名（不要只写 SCI/CSSCI 等本地分级）
- 国内奖项要英文化但不夸大：
  - "长江学者特聘教授" → "Changjiang Distinguished Professor (national-level professorship awarded to ~150 scholars/yr based on research excellence and academic leadership)"
  - "杰青" → "National Distinguished Young Scholar (NSFC top ~5%/yr nationally)"
  - "优青" → "Excellent Young Scholar (NSFC, top ~2%/yr in age cohort)"
- "TOP" 期刊在 ERC / NIH / NSF 评审里没意义；列出**领域内公认期刊**即可
- 引用次数用 Google Scholar / Web of Science 数据，注明数据日期 (e.g., "as of 2026-01")

### 2. NIH Personal Statement 的"故事感"

不是简历翻译。应包含：

- 一句话定位 PI 在领域中的位置
- "Why am I uniquely qualified to lead this project"
- 3-5 项最相关产出（与 Section C 不重复但可呼应）
- Ongoing projects 如何与本提案互补（不重复）

### 3. NSF Synergistic Activities 的"具体化"

避免"参与多项 outreach"这种泛泛之词。每条要：

- 名称 / 时间 / 角色
- 受众 / 影响数字（# of students reached, # of papers cited as case study, etc.）
- 与本提案 BI 的呼应（不是所有活动都列；选 5 个 strongest）

### 4. ERC Track Record 的"独立性"分别

- 区分 PhD / postdoc 阶段（first author，受 supervisor 引导）vs 独立 PI 阶段（senior/corresponding author）
- 独立性不足是中青年 PI 拿 Starting / Consolidator 最大的拦路虎
- 推荐做法：在每个主题下用"As an independent PI, I extended this work to..."句式显式标记起点

### 5. 国家社科活页的"匿名"

- **严禁出现**："我们课题组在 XX 期刊发表了 ..." / "本人主持的 NSFC 项目 ..." 等
- 代表作只列**已发表 + 完整引文**，评审专家不能从中识别身份
- "近 5 年成果"是底线，不要列 10 年前的
- 连续自引申请人著作 ≥ 3 篇会触发 "可能为申请人本人"嫌疑——分散排列

### 6. 团队成员介绍的"分工显化"

无论中外项目，**团队成员介绍必须含与本提案的分工**：

- 弱：「张三，副教授，研究方向为 X，主持 Y 项目 5 项」
- 强：「张三，副教授，主持 Y 项目，专长 [具体技术]，**在本项目中负责 Aim 2 的 [具体任务]，预计投入 50% 时间 × 3 年**」

## 工作流

1. 询问目标项目（决定模板）+ 7 个输入信息
2. 按模板出骨架
3. 帮 PI 选 representative publications（**用对应方向**而非堆 IF）
4. **按"30 秒电梯演讲"模板**写 Personal Statement / Track Record 第一句
5. 检查"独立性 vs 早期合作"区分（NIH / ERC 适用）
6. 检查国际可读性（如目标是 NIH/NSF/ERC/MSCA）
7. 检查匿名性（如目标是国家社科活页）
8. 检查团队分工显化

## 自检清单

- [ ] 篇幅符合体例上限（NIH 5p / NSF 3p / ERC 2+2p / 国家社科 1/4 活页）？
- [ ] Personal Statement 第 1 段含"30 秒电梯演讲" 3 句？
- [ ] 选的代表作与本提案方向一致？
- [ ] 体现了 PI 在该方向的**独立贡献**（区分 first author vs senior author）？
- [ ] 国际项目：所有中文奖项 / 期刊都英文化 + 1 句说明？
- [ ] NIH Section C 按 3-5 主题分组，每主题 ≤ 4 篇代表作？
- [ ] ERC Track Record 按 3 主题分组，每主题首句为"contribution sentence"？
- [ ] 国家社科：是否完全匿名？连续自引 < 3 篇？
- [ ] 团队成员介绍是否含与本课题的明确分工 + 时间投入？
- [ ] (NIH) Other Support / 中国资助披露已写？

## 与其他 Skill 衔接

- 学术英文 polishing → `nature-polishing` / `econ-write`
- 文献整理 → `zotero` Skill
- 代表作筛选可结合 → `verify-citations`
- 30 秒电梯演讲扩展 → `prompts/elevator-pitch.md`
