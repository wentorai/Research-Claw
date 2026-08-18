# 国际项目预算编制（Direct vs Indirect Cost / Overhead）

国际资助预算结构与国内项目差异较大，最常见踩雷点是**间接费用 / overhead** 的处理。

## 1. 基本概念

### Direct Cost（直接费用）
直接归因于本项目的费用：
- Salaries & wages + fringe benefits
- Equipment（capitalization 以上的资本性设备，常以 $5,000 为门槛）
- Materials & supplies
- Travel
- Publication / open access fees
- Subaward to collaborating institutions
- Consultant fees
- Computer services / cloud

### Indirect Cost / F&A / Overhead（间接费用）
机构基础设施成本（房屋折旧、IT、HR、行政、图书馆等）。
- 美国 / 欧洲机构通过与资助方签订 **Negotiated Indirect Cost Rate Agreement (NICRA)** 确定 rate
- Rate 计算方式：通常基于 **Modified Total Direct Cost (MTDC)** — 即扣除 equipment、subaward >$25K、tuition、participant support 等之后的 direct cost 基数
- US R1 大学 NICRA 通常在 **55%-70%** range（依机构）
- 欧洲大学 / 中国大学的 overhead 政策由各国 / 各机构自定

## 2. NIH 预算

### Modular vs Detailed Budget

- **Modular budget**：direct cost ≤ $250K/yr，按 $25K modules 申报，**不需要逐项列费用**
- **Detailed budget**：direct cost > $250K/yr，必须详列

### 关键科目限制

- **Salary cap**：NIH 设 PI / personnel salary cap（按 Executive Level II 标准，每年调整，2024 fiscal year 约 $221,900；超过部分需机构自筹）
- **Equipment**：列在 "Equipment" 而非 "Other"，单价 ≥ $5,000
- **Travel**：分 domestic vs foreign；foreign travel 需 justification
- **Consortium / Subaward**：subaward 总额 > $25K 部分**不计入** indirect cost base
- **Participant Support Costs**：用于受试者支付的费用，**不计入 indirect cost base**

### Budget Justification 写法

每项费用都要 1-2 句 justification：
```
Personnel: PI Smith (1.8 calendar months/yr) - will lead project design...
Postdoc TBN (12 calendar months) - will perform aim 1 experiments...
Materials: $X - includes antibodies (vendor / catalog # if known)...
Travel: $X - 2 domestic conferences (ASM, ASCB) + 1 international (EMBO)
Publication: $X - 2 open-access articles per year at $X each
```

## 3. NSF 预算

### 主要科目

A. Senior Personnel salary
B. Other Personnel
C. Fringe Benefits
D. Equipment
E. Travel（domestic / foreign 分列）
F. Participant Support Costs
G. Other Direct Costs（含 materials, publication, consultant, computer, subawards）
H. Total Direct Costs
I. Indirect Costs (F&A) — 通常按机构 NICRA 应用于 **MTDC 基数**
J. Total Direct + Indirect Costs

### 关键限制

- **PI summer salary**：NSF "two-month rule" — PI 一年内从 NSF 项目（含本项目 + 其他 NSF active grants）拿到的 summer salary 总和**不超过 2 个月**（除特殊例外）
- **CAREER**：min total budget $400K-$500K（Division-specific，PAPPG 公布）
- **Participant Support**：用于学生 / 学员津贴，需 prior approval 才能 rebudget 出该科目
- **Equipment**：单价 ≥ $5,000 + 使用寿命 > 1 年，列在 D 科目，**不计 indirect cost**
- **Subawards**：subaward 总额前 $25K 计 indirect cost base，超出部分不计

## 4. ERC 预算

ERC 预算结构按 Horizon Europe 通用规则：

### 主要科目

1. **Personnel**：PI + team members 的人工成本（含 fringe benefits，按 host actual cost）
2. **Subcontracting**：≤ 总预算 ~10%，需充分理由
3. **Other Goods, Works and Services**：consumables、equipment depreciation、travel、publication、access fees
4. **Indirect costs (overhead)**：**flat rate 25%** of direct cost (不含 subcontracting + financial support to third parties)

### 关键限制

- **Host institution 必须在欧盟 / 协作国**
- **PI working time 要求**：StG/CoG ≥ 50%，AdG ≥ 30% 在 host institution
- **Equipment**：按 depreciation 计入 direct cost（不能 capitalized 一次性）
- **Lump sum option**：自 Horizon Europe 起部分 calls 改为 lump sum，预算 justification 改为 work package 拆分

## 5. MSCA Postdoctoral Fellowships 预算

MSCA PF 是 **unit cost** 制，**不是按实际花销报销**：

| 单位 | 月度 unit cost（参考 2021-2027 框架） |
|------|---------|
| Researcher Unit Cost (含 living + mobility) | 约 €5,080/月（依国家系数 country correction coefficient） |
| Family Allowance | 约 €660/月（如 fellow 已婚 / 有家属） |
| Long-term Leave / Special Needs | 视情况 |
| Research Costs (host 用于研究) | €1,000/月 |
| Training Costs | €500/月 |
| Management & indirect costs (host) | €650/月 |

**Country correction coefficient** 调整 living allowance（按生活成本，如瑞士 ×1.05、土耳其 ×0.7 等，年度更新）。

## 6. 国内 PI 在国际项目中的预算坑

### 6.1 Subaward / Foreign Component Disclosure
- NIH：所有 foreign component（即在美国之外进行的 substantive scientific contribution）必须在 **Other Support** 与 cover letter 披露
- NIH 自 2021 起加强 disclosure 审查；**漏报 foreign component 会导致项目撤销**

### 6.2 NSFC 与 NIH/NSF 重复资助风险
- 多数资助方禁止"同一研究内容获得双重资助"
- "Other Support" / "Current and Pending Support" 文件**必须列出**所有在研 + 申报中的资助（含 NSFC、社科基金等中国项目）
- 实际操作中，重叠的处理方式是"明确划分子目标，互不重复"

### 6.3 货币与国别政策风险
- 年度汇率波动会影响实际购买力，预算应预留 5-10% buffer
- 出口管制（ITAR / EAR）：涉及双 use 技术 / 密级实验室访问需特殊条款
- 数据主权（GDPR / 个人信息保护法）：跨境数据传输要在预算中包含合规费用（DPIA、IRB 国际复评等）

## 7. 预算编制的流程建议

1. **先做 scope（研究内容） → 再算预算**，反过来会导致 budget-driven design
2. **与本单位 sponsored projects office / 财务处合作**：machinery 套件 + NICRA + fringe rate 都需要他们盖章
3. **保留 5%-10% buffer** 给意外（设备维护、新增样本、汇率）
4. **Justification 与 Specific Aims 互证**：每笔费用必须能映射到某个 aim 的某个 sub-task

## 8. 常见高频踩雷

- 设备费列错（应该单独 Equipment 科目却塞在 Other）
- Indirect cost 算错 base（MTDC 没扣除应扣项）
- Salary cap 超过未在 justification 解释 institutional 自筹
- Foreign travel 没有 justification
- Subaward 超 $25K 部分错算 indirect cost base
- NSF participant support 错放 "Other Direct Cost"
- ERC overhead 误算（应统一 25% flat rate，不是按 host NICRA）
