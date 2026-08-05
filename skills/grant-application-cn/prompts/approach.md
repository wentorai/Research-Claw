# Prompt: 研究方案 / Approach 撰写

## 用途
帮助用户撰写各类项目的"研究方案 / 技术路线 / Approach / Methodology"段落。这是篇幅最大、技术细节最多、最容易暴露准备不足的部分。

## 项目体例映射

| 项目 | Section 名 | 篇幅指引 |
|------|-----------|---------|
| 国家社科基金 | "研究思路 + 具体研究方法 + 重点突破" | 占活页约 1/3，~3000-5000 字 |
| 教育部人文社科 | "研究内容、思路与方法" | ~3000-4000 字 |
| NSFC（互补 Skill） | "研究方案及可行性分析" | 4-6 页 |
| NIH R01 | Approach（Research Strategy 内） | 7-9 pages |
| NSF | Project Description 主体 | 8-12 pages |
| ERC B2 | Methodology + Work Plan | 8-10 pages（在 14-page B2 内） |
| MSCA PF | Implementation section | ~3 pages |

## 输入要求

询问用户：

1. 目标项目类型
2. **Specific Aims / 研究内容**（建议 2-4 个，互不依赖）
3. **核心研究方法**（实验 / 计量 / 调研 / 理论 / 历史 / 实验 / 仿真）
4. **数据 / 样本来源**
5. **Preliminary data 摘要**（图表名 + 一句话结论）
6. **可能的 pitfalls** + **alternative strategies**（这是最容易漏的部分）

## 通用结构模板

无论项目体例，研究方案都应回答 7 个问题：

1. **Aim 之间的逻辑关系**（必须独立，不能串联）
2. **每个 aim 的 working hypothesis**（粗体一句话）
3. **每个 aim 的 experimental / analytical design**（含样本量、统计、识别策略）
4. **预期结果**
5. **Pitfalls**（明确预想可能出现的问题）
6. **Alternative strategies**（如果出问题怎么办）
7. **Rigor & reproducibility**（盲法 / 预注册 / 数据共享）

## 体例特化输出模板

### 国家社科 / NSFC（中文体例）

```
研究思路（思路图建议附技术路线图）

子课题 1：[标题]
- 研究内容（1-2 段）
- 研究方法
  - 数据来源 / 样本框
  - 变量构造
  - 识别 / 分析策略
  - 稳健性检验
- 预期结论

子课题 2：[标题]
... 同上

子课题 3：...

技术路线图（建议作为申请书插图，位于本节末）

可行性分析
- 数据可获得性（已签订协议 / 已申请到 / 已购买）
- 方法成熟度（已掌握 / 已发表论文使用过）
- 团队分工
- 时间合理性
```

### NIH Approach 体例

```
APPROACH

Aim 1. [标题]

Rationale (1 paragraph)
Building on our preliminary data showing [Fig. X], we hypothesize that...

Experimental Design

Sub-aim 1.1: [子目标]
- Methods: [具体试剂 / 模型 / sample size]
- Statistical analysis: [test / power / multiple comparison correction]
- Expected outcome: [预期方向]

Sub-aim 1.2: ...

Potential Pitfalls and Alternative Strategies

Pitfall: [明确预想的问题]
Alternative: We will [备选方案] supported by [feasibility 证据]

Rigor and Reproducibility
- Authentication of key resources (cell lines, antibodies)
- Sex as a biological variable
- Sample size justification
- Blinding / randomization

Aim 2. [标题]
... 同上

Aim 3. [标题]
...

Timeline (Gantt chart 推荐)
```

### NSF / ERC 体例

```
Methodology and Work Plan

Work Package 1 (WP1): [标题]
- Objectives
- Tasks (T1.1, T1.2, ...)
- Deliverables (D1.1, D1.2, ...)
- Milestones (M1, M2, ...)
- Lead person + person-months

Work Package 2: ...

Risk Management
- Risk register: probability × impact
- Mitigation per risk

Interdependencies between WPs (Gantt chart)
```

## 高频踩雷点

### 通用
- 把"研究方案"写成"文献综述"
- 缺乏 power analysis / sample size justification（特别是实证 / 实验类）
- 不写 alternative strategies（评审最常诟病）
- 数据来源不明 / "拟自建数据库" 但没说怎么建
- 时间安排不合理（如 12 个月做完 5 个 wave 调研）

### 中文项目
- 技术路线图缺失或太抽象
- 每个子课题写成一篇独立论文摘要，不交代相互关系
- 研究方法只列方法名（"采用 DiD / 案例分析法"），不写步骤

### NIH
- 缺少 sex as biological variable
- 缺少 authentication of key resources
- Aim 1 失败导致 Aim 2/3 也垮（aims 不独立）
- 不写 statistical methods 的细节（test / multiple comparison / power）

### NSF / ERC
- 没有 work package 拆分
- 没有 deliverables / milestones
- 缺乏 risk register
- ERC 没体现 high-risk-high-gain 的处理（plan B 不够"敢"）

## 工作流

1. 询问目标体例 + 6 个输入
2. **强制要求** 用户先列出 pitfalls + alternatives；否则提醒补
3. 按体例产出骨架，每个 aim / WP 1 段
4. 检查 aim 独立性（任意一个失败时其他能否继续）
5. 检查时间合理性（每个 aim 的 person-months 加起来是否能在周期内完成）
6. 提醒插入技术路线图 / Gantt chart（图表建议调用 `publication-figures` Skill）

## 自检清单

每个 aim / WP 逐条问：

- [ ] 有清晰的 working hypothesis 吗？
- [ ] 样本量 / power 是否给出？
- [ ] 是否独立于其他 aim？
- [ ] 是否有 preliminary data / 已有方法 / 已有平台支撑可行？
- [ ] Pitfalls 是否写出？
- [ ] Alternative strategies 是否写出？
- [ ] 时间和 person-months 是否合理？

## 与其他 Skill 衔接

- 计量识别策略细节 → `causal-inference-cn` Skill
- 数据清洗规范 → `panel-data-rules` / `csmar-cleaning-cn` 等
- 技术路线图 → `nature-figure` / `research-diagram-cn`
- 论证密度 polishing → `econ-write` / `nature-polishing`
