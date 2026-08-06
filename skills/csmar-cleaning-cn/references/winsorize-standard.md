# 缩尾标准 (Winsorize)

## 为什么要缩尾

中国 A 股财务数据极值现象严重（坏账、巨额商誉减值、ST 公司盈余操控、IPO 当年异常 ROE 等），不缩尾的回归经常被几个极端值绑架。**缩尾 (winsorize) 是 OLS / 面板回归前的标配预处理**。

> "缩尾"≠"截尾"。**缩尾 (winsorize)** 把超过分位数阈值的观测**替换为分位数值**（保留观测）；**截尾 (truncate)** 直接**删除**这些观测（损失观测）。实证经管论文绝大多数选缩尾。

---

## 标准选择：1% / 99%

主流做法：**对所有连续变量按 1% 与 99% 分位数双侧缩尾**（即把最低 1% 拉到第 1 百分位、把最高 1% 压到第 99 百分位）。

| 选项 | 适用场景 |
|---|---|
| 1% / 99%（双侧 1%） | **默认**。多数顶刊论文使用 |
| 5% / 95%（双侧 5%） | 数据噪声极大、样本极小（< 1000） |
| 仅上侧缩 99%（单侧） | 仅有右尾异常（如研发投入） |

**审稿人偏好**：财务期刊（《会计研究》《管理世界》《Journal of Finance》《RAS》）默认 1%；管理学期刊偶见 5%。**保险做法**：1% 主回归 + 5% 稳健性。

---

## 缩尾的三种粒度

| 粒度 | 命令示意 | 适用 |
|---|---|---|
| 全样本 (pooled) | `winsor2 var, cuts(1 99)` | **默认**，绝大多数论文 |
| 按年缩尾 | `winsor2 var, cuts(1 99) by(year)` | 跨年差异极大（恶性通胀 / 政策突变） |
| 按行业缩尾 | `winsor2 var, cuts(1 99) by(IndCd)` | 行业间口径差异大（如杠杆率：金融业天然高） |
| 按行业-年缩尾 | `winsor2 var, cuts(1 99) by(IndCd year)` | **最严格**，但小行业-年单元可能仅几个观测 |

**经验法则**：
- 全样本缩尾 → 简单透明，主流默认
- 按年缩尾 → 时间序列长（10 年以上）+ 跨年口径变化大时考虑
- 按行业缩尾 → **当极值的行业属性明显**（如金融业资产规模天然大几个量级）。但若已经剔除金融业，组间差异通常不需要再这样做
- 按行业-年缩尾 → 仅在样本量足够（每个行业-年 cell ≥ 30）时使用

---

## Stata: `winsor2` 包

最常用的实现。

```stata
* 安装
ssc install winsor2

* 基本用法（全样本，1%/99% 缩尾，覆盖原变量）
winsor2 roa lev size growth bm, replace cuts(1 99)

* 不覆盖原变量，新增 _w 后缀
winsor2 roa lev, cuts(1 99)
* 输出 roa_w / lev_w 两个新变量

* 按年缩尾
winsor2 roa lev, replace cuts(1 99) by(year)

* 按行业缩尾（CSRC 大类）
winsor2 roa lev, replace cuts(1 99) by(IndCd)

* 单侧（只压上侧）
winsor2 rd, replace cuts(0 99)
* cuts(0 99) 表示左侧不动，右侧压到 99 分位
```

**`winsor` vs `winsor2`**：
- `winsor`（旧版）：单变量，参数复杂
- `winsor2`：多变量、支持分组、覆盖原变量。**强烈推荐 `winsor2`**

**踩坑提醒**：
- `winsor2` 默认 **`cuts(1 99)`** 即 1%/99%，不要误以为是 0.01/0.99
- `cuts(5 95)` 表示 5%/95%
- `replace` 必须显式写出，否则会创建 `_w` 后缀新变量

---

## R: `DescTools::Winsorize`

```r
# install.packages("DescTools")
library(DescTools)

# 基本用法（默认 5%/95%，注意默认值与 Stata 不同！）
df$roa_w <- Winsorize(df$roa, probs = c(0.01, 0.99), na.rm = TRUE)

# 按行业缩尾（dplyr）
library(dplyr)
df <- df %>%
  group_by(IndCd) %>%
  mutate(roa_w = Winsorize(roa, probs = c(0.01, 0.99), na.rm = TRUE)) %>%
  ungroup()

# 多变量批量缩尾
vars <- c("roa", "lev", "size", "growth")
df[paste0(vars, "_w")] <- lapply(df[vars],
  function(x) Winsorize(x, probs = c(0.01, 0.99), na.rm = TRUE))
```

**踩坑提醒**：
- `DescTools::Winsorize` **默认是 5%/95%**（`probs = c(0.05, 0.95)`），**必须显式传 `probs = c(0.01, 0.99)`**！
- 这是 Stata 用户最容易踩的坑

---

## Python: `scipy.stats.mstats.winsorize`

```python
import pandas as pd
import numpy as np
from scipy.stats.mstats import winsorize

# scipy 的接口：limits 参数表示 (下侧裁剪比例, 上侧裁剪比例)
# 1% / 99% 缩尾 → limits=(0.01, 0.01)
df["roa_w"] = winsorize(df["roa"], limits=(0.01, 0.01)).data

# 处理 NaN：scipy.winsorize 会把 NaN 排序到最高，导致上侧错误压缩
# 推荐做法：先 dropna 或自写函数
def winsorize_safe(s, lower=0.01, upper=0.01):
    """忽略 NaN 后做缩尾"""
    s = s.copy()
    nonna = s.dropna()
    lo = nonna.quantile(lower)
    hi = nonna.quantile(1 - upper)
    s = s.clip(lower=lo, upper=hi)
    return s

# 全样本缩尾
df["roa_w"] = winsorize_safe(df["roa"], 0.01, 0.01)

# 按行业缩尾
df["roa_w"] = df.groupby("IndCd")["roa"].transform(
    lambda s: winsorize_safe(s, 0.01, 0.01)
)

# 按行业-年缩尾
df["roa_w"] = df.groupby(["IndCd", "year"])["roa"].transform(
    lambda s: winsorize_safe(s, 0.01, 0.01)
)
```

**踩坑提醒**：
- `scipy.stats.mstats.winsorize` 的 `limits` 是**比例**（0.01 = 1%），不是百分位
- `limits=(0.01, 0.01)` = 双侧 1%；`limits=(0, 0.01)` = 仅上侧
- 返回的是 `MaskedArray`，需用 `.data` 转回 `numpy.ndarray`
- **强烈建议自写 `winsorize_safe`**：scipy 实现对 NaN 处理不一致，跨版本可能行为变化

---

## 三方法等价性对照表

| 操作 | Stata `winsor2` | R `DescTools::Winsorize` | Python (自写) |
|---|---|---|---|
| 全样本 1%/99% | `winsor2 x, replace cuts(1 99)` | `Winsorize(x, probs=c(0.01, 0.99))` | `clip(quantile(0.01), quantile(0.99))` |
| 按年 1%/99% | `winsor2 x, replace cuts(1 99) by(year)` | `df %>% group_by(year) %>% mutate(...)` | `groupby("year")["x"].transform(...)` |
| 按行业 1%/99% | `winsor2 x, replace cuts(1 99) by(IndCd)` | `df %>% group_by(IndCd) %>% mutate(...)` | `groupby("IndCd")["x"].transform(...)` |

---

## 缩尾顺序的"金标准"

**正确顺序**：
1. 完成所有样本筛选（剔金融、剔 ST、剔 IPO 当年等）
2. 计算所有衍生变量（ROA、Lev、Size、BM 等）
3. **在最终样本上**对所有连续变量做一次性缩尾
4. 进入回归

**错误顺序（论文常见 bug）**：
- ❌ 先缩尾 → 后剔除子样本：剔除后某些变量的极端值可能被错误的"全样本"分位数固定
- ❌ 在每个回归子样本里重新缩尾：会让不同回归的样本不可比，并且小子样本缩尾噪声大
- ❌ 缩尾后再算比率：分子分母都缩尾了的比率失去经济含义

**例外**：若研究设计本身就是分组比较（如"国企 vs 民企"），可在主回归用全样本缩尾、稳健性用分组缩尾。

---

## 分位数缩尾 vs 标准差缩尾

| 方法 | 含义 | 优点 | 缺点 |
|---|---|---|---|
| 分位数 (1%/99%) | 把超过 1/99 分位数的观测替换为该分位数 | 不受分布假设影响 | 总是缩 2% 观测，无论分布如何 |
| ±3 标准差 | 把超过 ±3σ 的观测替换为 ±3σ | 与正态分布的 99.7% 一致 | 受异常值影响（异常值会拉大 σ） |

**实证经管论文 99% 用分位数法**。±3σ 法仅在工业 / 金融工程文献偶见。
