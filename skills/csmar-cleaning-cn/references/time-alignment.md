# 时间对齐

CSMAR 数据按"日 / 月 / 季 / 年"四种频率交叉存在。**时间对齐错误**是面板数据 bug 的高发区。

---

## 频率分类

| 频率 | 字段 | 表举例 |
|---|---|---|
| 日 | `Trddt` (YYYY-MM-DD) | `TRD_Dalyr` |
| 月 | `Trdmnt` (YYYY-MM) | `TRD_Mnth` |
| 季 / 半年 | `Accper` (YYYY-MM-DD，固定为 03-31 / 06-30 / 09-30 / 12-31) | `FS_Combas`, `FS_Comins` |
| 年 | `year` 或 `Reptdt` (YYYY-12-31) | `CG_Ybasic` |

---

## 关键认知 1：财报年度 = 自然年（A 股）

- 中国 A 股**全部**采用日历年 (Calendar Year) 作为会计年度，即 1 月 1 日 – 12 月 31 日
- 因此 `Accper = 2020-12-31` 即"2020 年年报"
- 不像美国，CSMAR 中**没有非历年财年问题**（对比 US Compustat 的 fiscal year != calendar year）

> 例外：极少数 H 股 / 红筹回归 A 股的公司可能调整过财年；但纯 A 股都是日历年。

---

## 关键认知 2：季报 ≠ 季度数据

`FS_Combas` 中季度结束日有四种：`03-31`、`06-30`、`09-30`、`12-31`，分别是一季报、半年报（H1）、三季报（前 9 月）、年报。

**但财务报表是"累计值"** —— 半年报的"营业收入" = 1 月至 6 月累计；三季报的"营业收入" = 1 月至 9 月累计。**不能直接相加得到全年值**。

```
2020-03-31 营业收入 = Q1 收入
2020-06-30 营业收入 = Q1 + Q2 收入（不是 Q2 单季）
2020-09-30 营业收入 = Q1 + Q2 + Q3 收入
2020-12-31 营业收入 = 全年收入
```

要得到"单季"值，需要差分：

```python
df = df.sort_values(["Stkcd", "Accper"])
df["quarter_revenue"] = df.groupby("Stkcd")["B001100000"].diff()
# Q1 的 diff 为 NaN（与去年 Q4 相减）—— 需特殊处理
df.loc[df["Accper"].dt.month == 3, "quarter_revenue"] = df["B001100000"]
```

---

## 关键认知 3：财报披露存在时滞

A 股年报披露规则：
- 年报：会计期间结束后 4 个月内（次年 4 月 30 日前）
- 半年报：会计期间结束后 2 个月内（8 月 31 日前）
- 季报：会计期间结束后 1 个月内（次月底前）

**结论**：**`Accper = 2020-12-31` 的年报数据，市场通常在 2021-03 至 2021-04 才能获得**。

**实证含义（防止 look-ahead bias）**：
- 用 t 期年报数据预测 t+1 年股票收益时，应保证收益从 **t+1 年 5 月**开始计算（确保所有公司年报已披露）
- 严格做法：合并财报数据用 `披露日期 (DeclareDate)` 而非 `Accper`

```stata
* 合并年报到月度收益面板，避免 look-ahead
gen yr_used = year(Trdmnt)
* 4 月 30 日之前用 t-2 年的年报，5 月 1 日之后才能用 t-1 年的年报
gen Accper_used = mdy(12, 31, yr_used - 2) if month(Trdmnt) <= 4
replace Accper_used = mdy(12, 31, yr_used - 1) if month(Trdmnt) > 4
```

或用更稳健的"披露日"做法：

```stata
gen DeclareDate_plus_1day = DeclareDate + 1
* 收益日期 ≥ 披露日 + 1 天，才能使用该期财报
```

---

## 关键认知 4：交易日 ≠ 自然日

A 股每年约 240 个交易日。日度数据合并需要：

- 日度收益匹配日度行情（同一 `Trddt`）—— 直接 inner join
- 日度收益匹配月末市值 —— 用 `Trdmnt = year-month(Trddt)` 后 merge
- 日度收益匹配年报 —— 经过披露时滞调整后再 merge（见上）
- 日度收益匹配宏观月度数据（CPI、利率）—— 用 `Trdmnt` merge

---

## 频率转换实战

### 日 → 月

```python
import pandas as pd

# CSMAR 已有 TRD_Mnth，直接用即可。下面是"自己算"的方法（兜底）
daily = pd.read_csv("trd_dalyr.csv", parse_dates=["Trddt"])
daily["Trdmnt"] = daily["Trddt"].dt.to_period("M")

# 月度收益 = (1 + r1)(1 + r2)...(1 + rn) - 1
monthly = daily.groupby(["Stkcd", "Trdmnt"]).agg(
    Mretwd=("Dretwd", lambda x: (1 + x).prod() - 1),
    Mclsprc=("Clsprc", "last"),
    Msmvosd=("Dsmvosd", "last"),  # 月末值
).reset_index()
```

### 月 → 年

```python
monthly["year"] = monthly["Trdmnt"].dt.year
yearly = monthly.groupby(["Stkcd", "year"]).agg(
    annual_ret=("Mretwd", lambda x: (1 + x).prod() - 1),
    avg_size=("Msmvosd", "mean"),
).reset_index()
```

### 季 → 年（财报数据）

```python
# 直接取 12-31 的累计值即为年值
fs = pd.read_csv("fs_comins.csv", parse_dates=["Accper"])
yearly_fs = fs[fs["Accper"].dt.month == 12].copy()
yearly_fs["year"] = yearly_fs["Accper"].dt.year
```

### 季报年化（非全年，估算）

如果只到 Q3，可用 $4/3 \times \text{Q3 累计}$ 做线性年化：

```python
yearly_est = fs[fs["Accper"].dt.month == 9].copy()
yearly_est["annual_revenue_est"] = yearly_est["B001100000"] * 4 / 3
```

> 季节性强的行业（农业、零售、暖通）线性年化不合适；应改用 LIYE (Last Twelve Months ending) 滚动 4 季加总。

---

## 合并样板：日度面板 + 年度财务

```stata
* daily_panel: Stkcd, Trddt, Dretwd, Clsprc
* annual_fs: Stkcd, year, ROA, Lev, Size

use daily_panel, clear

* 时滞调整：4 月 30 日前用 t-2 年报，5 月 1 日后用 t-1 年报
gen yr = year(Trddt)
gen mn = month(Trddt)
gen merge_year = cond(mn <= 4, yr - 2, yr - 1)

* merge
rename merge_year year
merge m:1 Stkcd year using annual_fs, keep(master match) gen(_m_fs)
```

---

## 速查：如何判断时间对齐对不对

执行回归前的自检清单：

1. `xtset Stkcd year` 后用 `xtdescribe` 看面板是否平衡 / 时间间隔是否合理
2. 用 `tab year` 看每年观测数——若 `2009 年突然剧增`，可能是时间字段错误
3. 抽 1–2 家公司，手动看 `list Stkcd year roa` 前后是否合理（ROA 同年的两个值？说明合并出现了 1:m 错配）
4. 交叉验证：年度财务的 `Accper-12-31` 数据与 `FN_Fn041` 的年度指标应一致（除非 CSMAR 重新计算过）

---

## 频率不匹配的典型 bug

| 症状 | 可能原因 |
|---|---|
| `merge` 后样本量翻 4 倍 | 月度面板与季度财报 m:m 错配（应先把季报转年报） |
| `xtreg` 显示"重复观测" | 同一 `Stkcd-year` 有多条（半年报 + 年报都被保留） |
| 回归系数符号反 | 用了未来信息（look-ahead），t 期收益用 t 期年报但 t 期年报 4 月才披露 |
| 面板"洞" | 暂停上市 / 退市 / IPO 前 —— 多数情况不是 bug，是真实情况 |
