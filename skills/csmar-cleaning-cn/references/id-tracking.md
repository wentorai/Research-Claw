# 公司 ID 变更 / 重组 / 退市 / 借壳处理

中国 A 股有大量"壳资源"重组、借壳上市、ST 摘帽、暂停上市再恢复等情形，导致**`Stkcd` (股票代码) 与"公司主体"并不一一对应**。本文件梳理常见情形与处理方式。

---

## CSMAR 中两套 ID

| ID | 字段 | 含义 | 是否可变 |
|---|---|---|---|
| `Stkcd` | 股票代码（6 位数字字符串） | 上交所/深交所分配的代码 | 通常稳定，但壳重组可能保持不变 |
| `Symbol` | 内部代码 | CSMAR 自己的唯一标识符（部分库表中） | CSMAR 内部稳定 |
| `CoID` / `Compcd` | 公司唯一标识 | 部分库表用，对应公司而非股票 | 稳定 |

**关键认知**：`Stkcd` ≠ "公司"。一个 `Stkcd` 在生命周期中可能：
1. 公司更名（`Stknme` 变，`Stkcd` 不变）→ 还是同一家公司
2. 借壳上市（壳公司 + 注入资产，`Stkcd` 不变但**主营业务、控股股东全换**）→ 经济上不是同一家公司
3. 退市后代码回收，多年后被新公司复用 → 不同公司共享同一代码

**论文实操建议**：在面板分析中如果要追踪"公司"层面变量（CEO 任期、研发投入累积等），不能简单用 `Stkcd`，需结合 `Stknme` 变化日期 + 重大资产重组事件确认主体连续性。

---

## 情形 1：股票简称变更（普通情形）

最常见——公司更名、ST 摘帽 / 戴帽、品牌升级。

例：
- 三一重工：长期为 `600031` → 简称稳定
- 中国石油 → 中石油：仅简称微调
- *ST → ST → 摘帽：简称改变但主体不变

**处理**：可忽略简称变更（`Stkcd` 不变即视为同一公司）。

**追踪表**：`TRD_Co`（上市公司股票代码及简称变更表）

---

## 情形 2：股票代码变更

罕见但存在。例如：
- 转板（少数案例：从主板转创业板/科创板会换代码）
- 沪深 B 转 A

**处理**：在数据清洗时构造一张 `old_code → new_code` 映射表，回溯历史观测。

**Stata 示意**：
```stata
* 构造 ID 桥接表 (id_bridge.dta)
* 字段：Stkcd_old, Stkcd_new, change_date
merge m:1 Stkcd using id_bridge, keepusing(Stkcd_new) gen(_m)
replace Stkcd = Stkcd_new if !missing(Stkcd_new) & Trddt > change_date
```

---

## 情形 3：借壳上市（最棘手）

**典型剧本**：
1. 老 ABC 公司经营恶化 → ST → *ST → 暂停上市
2. 大股东找一家未上市的优质公司 XYZ
3. ABC 通过定向增发把 XYZ 注入上市公司
4. 上市公司更名，控股股东变更
5. **`Stkcd` 不变，但主营业务、管理层、资产负债表全部换血**

**论文影响**：
- 财务面板出现"巨大跳变"——研发支出、营业收入、毛利率等指标突变
- 误以为是同一家公司经营改善，实则是换公司

**处理方式**：
- 严格做法：识别出借壳事件（CSMAR 有重大资产重组数据库 `M&A_DataBase`），将借壳前后视为两家公司，借壳前的样本删除或单独建模
- 松散做法：仅剔除借壳当年和后一年（避开过渡期跳变），后续视为同一公司

**识别借壳的快速代理**：
- 实际控制人变更（`CG_Capchg` 控股股东字段）
- 主营业务行业代码变化（`IndCd` 跨大类）
- 营业收入或总资产 YoY 增长 > 500%（启发式过滤）

---

## 情形 4：退市

退市后该 `Stkcd` 在 `TRD_Dalyr` 中不再出现新观测，但历史数据保留。

**处理**：
- 面板研究：**保留退市样本至退市日**（避免幸存者偏差）
- 横截面研究：仅用截面期仍上市的公司
- 事件研究：退市事件前 [-N, -1] 窗口可分析，[+0, +N] 不可（无后续交易）

**判定字段**：`EN_EnterpriseInfo.Delisting_Date` 或 `STK_LISTEDCOINFOANL.DelistDt`（具体字段名以最新数据手册为准）

---

## 情形 5：暂停上市再恢复

中国 A 股特有——暂停上市后可恢复（典型例子：南纺股份、ST 银山等）。

**判定**：`Trdsta` 字段中暂停上市码（具体编码以数据手册为准）

**处理**：暂停上市期间没有交易日数据；恢复后交易日重新出现。**面板回归默认 `xtset` 会保持时间间隔**，因此暂停期会形成"洞"。一般直接接受洞，不做特殊处理。

---

## 实战清洗模板：构造稳定的"公司层 ID"

如果研究问题是"CEO 治理对公司绩效的长期影响"这类需要追踪公司主体的，建议构造一个二级 ID `firm_id`：

```stata
* 步骤 1: 从 EN_EnterpriseInfo 取上市/退市日期
use EN_EnterpriseInfo, clear
keep Stkcd ListDt EstDt
tempfile listinfo
save `listinfo'

* 步骤 2: 主面板 merge
use main_panel, clear
merge m:1 Stkcd using `listinfo'

* 步骤 3: 检测控股股东变更（借壳 proxy）
* M&A_DataBase 字段：Stkcd, AnnouncementDate, EventType (借壳=...)
merge 1:m Stkcd using ma_events, keep(master match)
gen reverse_merger = (EventType == "借壳上市")
bys Stkcd: egen has_reverse = max(reverse_merger)

* 步骤 4: 构造 firm_id
* 借壳前后视为两家公司
gen firm_id = Stkcd
* 对发生借壳的公司，借壳后给新 ID
bys Stkcd (Trddt): gen seq_after_rm = sum(reverse_merger)
replace firm_id = Stkcd + "_after" if seq_after_rm > 0
```

---

## 速查表

| 情形 | 字段判定 | 推荐处理 |
|---|---|---|
| 简称变更 | `Stknme` 变 | 忽略 |
| 代码变更 | `Stkcd` 变 | 构造 bridge 表回溯 |
| 借壳上市 | `IndCd` 跨大类 / 控股股东变 | 视为两家公司 / 剔除过渡年 |
| 退市 | `Delisting_Date` 非空 | 保留退市前数据（避免幸存者偏差） |
| 暂停再恢复 | `Trdsta` 暂停码 | 接受面板洞 |

> 不要假设"同一 `Stkcd` = 同一公司"。这是中国 A 股数据清洗最隐蔽的陷阱之一。
