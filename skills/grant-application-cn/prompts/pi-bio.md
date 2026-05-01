# Prompt: 个人简介 / Biosketch / Track Record 撰写

## 用途
帮助用户撰写各类项目的"PI / 团队介绍"段落。**不同体例差异极大**：NIH 5-page biosketch + Personal Statement 与 ERC 2-page CV + 2-page Track Record + 国家社科"申请人 5 年代表作"完全不同。本 prompt 自动适配。

## 项目体例映射

| 项目 | 文件 / 段落 | 篇幅指引 |
|------|------------|---------|
| 国家社科 / 教育部 | "课题负责人主要研究专长 + 学术简历 + 已发表成果（限近 5 年）" + "课题组成员简介" | 占活页约 1/4 |
| NSFC（互补 Skill） | "研究基础与工作条件" + 个人简历表 | 1-2 页 |
| NIH | Biosketch（每位 key personnel）— Personal Statement + Positions + Contributions to Science + Scholastic Performance | **5 pages each** |
| NSF | Biographical Sketch — Identifying Info + Professional Preparation + Appointments + Products + Synergistic Activities | 3 pages each, **必须用 SciENcv 生成** |
| ERC | Part B1 PI CV + Track Record | **2 pages CV + 2 pages Track Record** |
| MSCA PF | Researcher CV + Supervisor CV | 视当年模板 |

## 输入要求

询问用户：
1. **目标项目类型**
2. **PI 学历 + 工作经历**（按时间倒序）
3. **代表作 5-10 篇**（含 DOI / 完整引文）
4. **主持过的资助 / 奖项 / 学会职务**
5. **培养博士生 / 博士后情况**（NIH/NSF 关心，国家社科较少关心）
6. **本研究方向上的最相关 3 篇产出**（用于 contributions to science / track record 的代表段）

## 体例特化输出模板

### NIH Biosketch（5 pages）

```
NAME: [Last, First Middle]
eRA COMMONS USER NAME: [if applicable]
POSITION TITLE: [职务]

A. Personal Statement
[~ 0.5-1 page]
- 一段话说明 PI 在本项目上的独特资质
- 列举 3-5 项最相关的产出（先于 Section C 的 contributions）
- 提及 ongoing / completed projects 与本提案的衔接（不与 Other Support 重复）

B. Positions, Scientific Appointments, and Honors
[~ 0.5-1 page]
- 倒序的职务（年-年: title, institution）
- Honors / Awards（不需要全部，挑国际级 / 学术学会级）

C. Contributions to Science
[~ 2-3 pages]
列出 3-5 个 "contribution" 主题。每个主题：
- 1 段说明主题、PI 的具体贡献、领域影响
- 列出 ≤ 4 篇 representative publications

注：不要堆叠 50 篇文章；选择能讲故事的代表作

D. Scholastic Performance
（仅限 fellowship / training grants 需要）
- 本科 / 研究生课程 + GPA
```

### NSF Biographical Sketch（3 pages，必须用 SciENcv 生成 PDF）

```
1. Identifying Information: name, ORCID, position, department

2. Professional Preparation
   [Institution] — [Major] — [Degree, Year]

3. Appointments
   倒序，年-年: title, institution

4. Products
   - Up to 5 publications most closely related to the proposed project
   - Up to 5 other significant publications
   （含 DOI / preprint URL）

5. Synergistic Activities (≤ 5 examples)
   - 教学创新 / outreach / 学会服务 / 工业界合作 / 数据共享
   - 简短 bullet，不超 1 页
```

### ERC Part B1 — PI CV（2 pages） + Track Record（2 pages）

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
- 区分 first author（学生 / 博士后）vs senior author（独立 PI）
- INVITED CONTRIBUTIONS / KEYNOTES
- PRIZES, AWARDS, ACADEMIES
- FUNDING ID
```

### 国家社科 / 教育部体例（活页要求）

```
课题负责人主要研究专长（500-800 字）
- 学科方向 + 已积累的核心问题
- 与本课题的延续关系

学术简历（按时间倒序）
- 教育经历
- 工作经历
- 学术职务（学会 / 期刊审稿）

近 5 年已发表成果（与课题相关，限 10 项）
- 论文：作者. 题目. 期刊, 年, 卷(期): 页
- 著作：作者. 书名. 出版社, 年
- 注：活页阶段不写 "我们" 等暴露身份的语言

主要参加者简介（每人 ≤ 200 字）
- 姓名 / 性别 / 出生年 / 职称 / 工作单位 / 研究专长 + 与本课题的分工
```

## 重要写作要点

### 1. 国际项目的"国际可读性"

中国 PI 常踩的雷：

- 中文期刊只写英文译名 + 期刊全名（不要只写 SCI/CSSCI 等本地分级）
- 国内奖项要英文化但不夸大（如"长江学者特聘教授" → "Changjiang Distinguished Professor"）
- "TOP" 期刊在 ERC / NIH / NSF 评审里没意义；列出**领域内公认期刊**即可
- 引用次数用 Google Scholar / Web of Science 数据，注明数据日期

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

### 4. ERC Track Record 的"独立性"分别

- 区分 PhD / postdoc 阶段（first author，受 supervisor 引导）vs 独立 PI 阶段（senior author）
- 独立性不足是中青年 PI 拿 Starting / Consolidator 最大的拦路虎

### 5. 国家社科活页的"匿名"

- **严禁出现**："我们课题组在 XX 期刊发表了 ..." / "本人主持的 NSFC 项目 ..." 等
- 代表作只列**已发表 + 完整引文**，评审专家不能从中识别身份
- "近 5 年成果"是底线，不要列 10 年前的

## 工作流

1. 询问目标项目（决定模板）+ 6 个输入信息
2. 按模板出骨架
3. 帮 PI 选 representative publications（**用对应方向**而非堆 IF）
4. 检查"独立性 vs 早期合作"区分（NIH / ERC 适用）
5. 检查国际可读性（如目标是 NIH/NSF/ERC/MSCA）
6. 检查匿名性（如目标是国家社科活页）

## 自检清单

- [ ] 篇幅符合体例上限？
- [ ] 选的代表作与本提案方向一致？
- [ ] 体现了 PI 在该方向的独立贡献？
- [ ] 国际项目：所有中文奖项 / 期刊都英文化？
- [ ] 国家社科：是否完全匿名？
- [ ] 团队成员介绍是否含与本课题的明确分工？

## 与其他 Skill 衔接

- 学术英文 polishing → `nature-polishing` / `econ-write`
- 文献整理 → `zotero` Skill
- 代表作筛选可结合 → `verify-citations`
