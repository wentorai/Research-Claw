# Prompt: 时间线 + 预算撰写

## 用途
帮助用户编制各类项目的"研究进度 / 时间线"和"经费预算 / Budget Justification"。这两块**单看不出问题，但与研究内容对照看就能露馅**。

## 项目体例映射

| 项目 | 时间线段落 | 预算文件 |
|------|-----------|---------|
| 国家社科 / 教育部 | "年度研究计划" | "经费概算"（直接 + 间接） |
| NSFC（互补 Skill） | "年度研究计划" | "预算说明书" |
| NIH | Resources / Project Timeline（Approach 内插图建议） | Budget + Budget Justification（modular vs detailed） |
| NSF | Project Timeline（Project Description 内） | Budget pages + Budget Justification |
| ERC | Work plan with Gantt chart in B2 | Budget table + justification |
| MSCA PF | Implementation Gantt | Unit cost based, 不需逐项预算 |

## Part A: 时间线 / Project Timeline

### 输入要求

1. 目标项目类型 + 周期（年数）
2. **Aim 列表**（已写好的研究方案产出）
3. **每个 aim 内的 sub-tasks**（≥ 3 个）
4. **里程碑事件**（数据采集完成 / 中期报告 / 第一篇论文投出）
5. **关键依赖关系**（task A 必须先于 task B 吗）

### 通用 Gantt 模板

```
Year 1            Year 2            Year 3
Q1 Q2 Q3 Q4   Q1 Q2 Q3 Q4   Q1 Q2 Q3 Q4

Aim 1
 ├ T1.1 ████████
 ├ T1.2    ████████████
 └ T1.3              ████████████

Aim 2
 ├ T2.1     ████████
 └ T2.2        ████████████████

Aim 3
 ├ T3.1                 ████████████
 └ T3.2                       ████████████

Cross-cutting
 ├ Data sharing                              ████████
 ├ Manuscripts        ▲          ▲       ▲      ▲
 └ Conferences        ★          ★       ★      ★

Milestones:
M1 (Q4 Y1): Aim 1 baseline data collection complete
M2 (Q2 Y2): First manuscript submitted
M3 (Q4 Y2): Mid-term review
M4 (Q4 Y3): All manuscripts submitted
```

### 时间线常见踩雷点

- 所有 task 都从 Q1 开始（不现实，应有 ramp-up）
- 数据采集 + 数据清洗 + 分析挤在 1 个 quarter 完成
- Manuscripts 在最后 1 quarter 全部"涌出"
- 没考虑伦理 / IRB / 数据获取审批的前置时间（通常 3-6 个月）
- 没考虑 PI / postdoc 招聘的 ramp-up 时间

### 体例特化模板

**国家社科 / NSFC**：用"年度研究计划"文字描述 + 简短 Gantt
```
2025 年（第一年）
- 上半年：完成文献综述 + 调研工具开发 + IRB 审批
- 下半年：第一轮调研 / 数据采集

2026 年（第二年）
- 上半年：数据清洗 + 分析框架开发
- 下半年：补充访谈 + 阶段成果（投稿 1 篇）

2027 年（第三年）
- 上半年：第二轮分析 + 比较研究
- 下半年：撰写最终成果（专著 / 系列论文）+ 结题
```

**NIH**：建议在 Approach 末尾插一个简短 Gantt 表

**ERC B2**：必须有 Work Package + Deliverables + Milestones 表
```
| WP | Title       | Lead | M-M  | Deliverables | Milestones |
|----|-------------|------|------|--------------|------------|
| 1  | Data infra  | PI   | 1-12 | D1.1, D1.2   | M1 (M12)   |
| 2  | Method dev  | PD1  | 6-30 | D2.1, D2.2   | M2 (M18)   |
| 3  | Application | PD2  |12-48 | D3.1, D3.2   | M3 (M36)   |
| 4  | Translation | PI   |36-60 | D4.1         | M4 (M60)   |
```

## Part B: 预算 / Budget Justification

### 输入要求

1. 目标项目类型（决定预算结构 + 上限）
2. **总额上限**（按当年指南）
3. **核心人员配置**（PI 几个月 / postdoc / PhD 学生 / RA / consultants）
4. **设备 / 耗材 / 数据**清单
5. **差旅** / **会议** / **publication** 预估
6. **Subaward / 合作单位** 是否需要

### 通用预算结构

详细规范见 `references/budget-international.md`。简表：

| 科目 | 国内（社科/教育部） | NIH | NSF | ERC |
|------|------------------|-----|-----|-----|
| 人员费 | 不能给在编人员 | 含 fringe，受 salary cap | A + B + C | Personnel cost |
| 设备 | ≤ 总额一定比例 | ≥ $5K 单列 | ≥ $5K 单列，不计 IDC | Depreciation 计 direct |
| 材料 | 详细列 | Materials | G | Other goods |
| 差旅 | 详细列 | 分国内 / 国外 | 分国内 / 国外 | Travel |
| 出版 | 详细列 | 含 OA | G | Other goods |
| Subaward | 不适用 | Consortium | G | Subcontracting ≤ ~10% |
| 间接费用 | 一般 ≤ 20-30% | 按 NICRA × MTDC | 按 NICRA × MTDC | Flat 25% |

### 体例特化输出模板

**NIH Modular (direct ≤ $250K/yr)**

```
Budget for Year 1: $250,000 direct cost (10 modules)
Total for 5 years: $1,250,000 direct + indirect cost (per institutional NICRA)

Personnel:
- Smith, J. (PI): 1.8 calendar months/yr — leads project design, supervises 
  postdocs, manages collaborations
- Postdoc TBN: 12 calendar months/yr — performs Aim 1 experiments
- Graduate Student: 12 calendar months/yr — performs Aim 2

Materials and Supplies: ~$X
- Antibodies, reagents, consumables (estimated based on Aim 1.1 + 1.2)

Travel: ~$X
- 1 domestic conference (PI + postdoc) + 1 international (PI)

Publication: ~$X
- 2 OA articles per year at $X each

Other:
- Animal per diem (estimated X mice × Y days × $Z)

(Modular budget 不需要 detailed line items, but justification still required.)
```

**NSF Detailed**

```
A. Senior Personnel:
   PI Smith (1 month summer salary × 5 yr × $X/yr) = $X
B. Other Personnel:
   1 Postdoc (12 months × 5 yr × $X) = $X
   2 Graduate Students (12 months × 5 yr × $X) = $X
C. Fringe Benefits (per institutional rate):
   Senior personnel: X% of A
   Postdoc: X% of B
   Students: X% of B
D. Equipment: $X (single-cell sequencer, justified by Aim 2)
E. Travel:
   Domestic: $X (2 conferences/yr)
   Foreign: $X (1 international conference/yr, justified by collaboration)
F. Participant Support: $X (REU students, summer school)
G. Other Direct Costs:
   Materials & Supplies: $X
   Publication: $X
   Computer Services: $X (cloud)
   Subawards: $X (Subaward to U. of X for Aim 3 collaboration)
H. Total Direct: $X
I. Indirect Costs: NICRA X% of MTDC = $X
J. Total: $X
```

**ERC Budget**

```
Total project budget: €Y over 5 years (within ERC StG/CoG/AdG cap)

Direct costs (75%):
  Personnel:
    PI: 50% time × 5 yr (or 30% for AdG)
    PD1: 36 months
    PD2: 36 months
    PhD students: 2 × 48 months
  Subcontracting: ≤ 10% of total direct
  Other goods, works, services:
    Equipment depreciation
    Consumables
    Travel
    Open access publication
    Computational resources

Indirect costs (25% flat rate of direct cost excluding subcontracting):
  €X
```

**国家社科 / 教育部**

```
经费预算（总额：__ 万元）

直接费用：
1. 资料费：__ 万（含数据库订阅、调研资料、文献购置）
2. 调研 / 差旅费：__ 万（含 X 次田野调研、Y 次学术会议）
3. 会议费：__ 万（含 1 次专家咨询会）
4. 劳务费：__ 万（含 X 名研究生 / 调研员，按 X 元/月 × Y 月）
5. 专家咨询费：__ 万（含 X 人次咨询）
6. 出版 / 文献检索费：__ 万
7. 其他：__ 万

间接费用（如适用）：__ 万

经费用法说明：
- 资料费用于 ...（一句话 justification）
- 调研费用于 ...
- ...
```

### 预算高频踩雷

1. **设备费过高**（青年项目尤其敏感）
2. **劳务费给在编人员**（国内项目违规）
3. **Indirect cost base 算错**（MTDC 没扣除 equipment / subaward >$25K）
4. **Salary cap 超过未自筹**（NIH）
5. **NSF participant support 错放 Other Direct**
6. **ERC overhead 误算**（应统一 25% flat rate）
7. **Foreign travel 没 justification**
8. **Subaward 比例过大**（ERC 限 ~10%；NIH 留意 foreign component disclosure）
9. **预算与研究内容明显不匹配**（如做实验项目但耗材费极少）

## 工作流

1. 询问目标项目 + 输入信息
2. 先出**时间线骨架**（Gantt），让用户调整 ramp-up 与依赖
3. 反推**人月数**（每个 aim / WP 需要多少 person-months）
4. 按体例填**预算表 + justification**
5. 与研究方案做**互证检查**：每个 aim 是否在预算里有对应人员 + 物资？
6. 提醒**当年指南限额** / **NICRA / fringe rate** 必须找单位科研处确认

## 自检清单

时间线：
- [ ] 第 1 个 quarter 是否有 ramp-up 而非全速？
- [ ] 数据采集 + 清洗 + 分析是否分阶段？
- [ ] IRB / 数据审批前置时间预留？
- [ ] Manuscripts 不是最后一刻全部涌出？
- [ ] 与研究内容里的子任务一一对应？

预算：
- [ ] 总额在指南上限内？
- [ ] 每项有 justification？
- [ ] Indirect cost base / rate 来自单位科研处？
- [ ] 与研究方案 / 人员配置自洽？
- [ ] 国际项目：Other Support / foreign component 已披露？
- [ ] 国内项目：劳务费 / 设备费比例合规？

## 与其他 Skill 衔接

- 国际项目预算细节 → `references/budget-international.md`
- Gantt 图绘制 → `publication-figures` Skill
- 单位 NICRA / fringe rate 查询：必须通过本单位 sponsored projects office
