# Stata / R / Python Workflow

This reference provides conservative defaults. Treat journal-specific author instructions as authoritative when available.

经管学者大多熟悉 Stata，但 Stata 的绘图能力有限；R 的 ggplot2 + fixest 在事件研究和网络上更强；Python 的 matplotlib + geopandas + plotly 在多面板组合、地图、交互上不可替代。本文给出三语言**何时用哪个**与**互转思路**。

---

## 1. 选用建议（决策树）

```
你的核心数据已经在哪里？
├── Stata .dta，主回归也在 Stata 里跑
│   ├── 系数图 → coefplot  ★ 最快
│   ├── 边际效应 → margins + marginsplot
│   ├── Bunching → 自实现
│   └── 想画地图 / 网络 / Sankey → 跳到 R 或 Python（Stata 不擅长）
│
├── R tibble，主分析在 R 里
│   ├── 事件研究 → fixest::feols + fixest::iplot  ★ 最快
│   ├── 系数对比 → dotwhisker
│   ├── 中国地图 → sf + 行政区划 shapefile
│   ├── 网络 → igraph + ggraph
│   └── 元分析 → forestplot / metafor
│
└── Python DataFrame，主分析在 Python 里
    ├── 复杂多面板 → matplotlib subplots
    ├── 地图 → geopandas
    ├── Sankey / 交互 → plotly
    ├── 网络 → networkx
    └── 聚类热图 → seaborn.clustermap
```

---

## 2. 三语言"系数图"等价代码对照

### Stata

```stata
ssc install coefplot
reg y x1 x2 c1 c2, r
estimates store m1
reg y x1 x2 c1 c2 c3 c4, r
estimates store m2
coefplot m1 m2, keep(x1 x2) horizontal xline(0)
```

### R

```r
library(fixest); library(dotwhisker); library(ggplot2)
m1 <- feols(y ~ x1 + x2 + c1 + c2, data = df)
m2 <- feols(y ~ x1 + x2 + c1 + c2 + c3 + c4, data = df)
dwplot(list("Model 1" = m1, "Model 2" = m2), vars_order = c("x1", "x2"))
```

### Python

```python
import statsmodels.api as sm
import matplotlib.pyplot as plt
m1 = sm.OLS(y, sm.add_constant(X1)).fit(cov_type="HC3")
m2 = sm.OLS(y, sm.add_constant(X2)).fit(cov_type="HC3")
# 自己取 m1.params, m1.bse 画 errorbar
```

**结论**：系数图 Stata 最快、R 次之、Python 最繁琐。**主回归在 Stata，画图也用 Stata**。

---

## 3. 数据互转

### Stata → R

```stata
save "data.dta", replace
```

```r
library(haven)
df <- read_dta("data.dta")
```

### Stata → Python

```python
import pandas as pd
df = pd.read_stata("data.dta")
```

### R / Python → Stata

```r
library(haven); write_dta(df, "out.dta", version = 14)
```

```python
df.to_stata("out.dta", version=117)
```

---

## 4. 估计结果互转（regression objects）

需求：Stata 跑了 6 个回归，想用 Python / R 画图。

**方案 A**：在 Stata 里 `outreg2` / `estout` 导出系数到 CSV，画图脚本读 CSV：

```stata
estout m1 m2 m3 using coefs.csv, replace cells("b se ci_l ci_u")
```

**方案 B**：Python 用 `pyreadstat` 读 Stata 的 dta（不直接支持 ereturn list，但可读 dta）。

**方案 C**：R 用 `broom::tidy(estimates)` 直接转 tibble。

**推荐**：在画图阶段，**统一存 CSV/Parquet 中转**，把"模型对象"概念去掉，只保留 (coef, se, ci_lo, ci_hi, pvalue, n)。

---

## 5. 字体设置

### Stata

```stata
graph set window fontface "Times New Roman"
graph set window fontfaceserif "SimSun"
```

### R

```r
library(showtext)
font_add("SimSun", "/System/Library/Fonts/Songti.ttc")
showtext_auto()
```

### Python

```python
import matplotlib.pyplot as plt
plt.rcParams["font.family"] = "serif"
plt.rcParams["font.serif"] = ["Times New Roman", "SimSun", "Songti SC",
                              "Source Han Serif SC", "STSong"]
```

---

## 6. 导出 PDF 矢量

| 语言 | 命令 |
|------|------|
| Stata | `graph export "fig.pdf", as(pdf) replace` |
| R | `ggsave("fig.pdf", width = 8.5, height = 6, units = "cm")` |
| Python | `fig.savefig("fig.pdf", bbox_inches="tight", dpi=300)` |

---

## 7. 何时跨语言（不要 over-engineer）

跨语言成本高，**只在以下情况建议跨**：

1. Stata 跑的主回归，想画 R 的事件研究 → 导 dta 给 R
2. Python 整理的全国地市级数据，想用 R sf 画地图 → 导 parquet 给 R
3. 主分析用 R，想用 Python 的 plotly 做交互 Sankey → 导 csv 给 Python

**不要**：为了"赶时髦"把 Stata 的 coefplot 重写成 Python；丑且慢。

---

## 8. 推荐工作流模板

### 模式 A：纯 Stata 党

```
data.dta → 主回归 (Stata) → coefplot.do → fig.pdf → LaTeX
```

### 模式 B：Stata + R 党（DiD 论文常见）

```
data.dta → 主回归 (Stata) → 导 dta
                          ↓
                          R: fixest event_study.R → fig.pdf
```

### 模式 C：Python 全栈（机器学习 / 文本数据）

```
parquet → 主分析 (Python pandas / statsmodels)
       → coefplot.py / event_study.py → fig.pdf
```

### 模式 D：混合（最常见）

```
Stata 出主表           → table.tex
R 出事件研究图         → event_study.pdf
Python 出地图/网络     → map.pdf / network.pdf
统一进 LaTeX
```

---

## 9. 一个常见坑

R 的 `fixest::iplot` 输出的事件研究图，**默认用基期 t = -1**，但若数据 panel 不平衡（处理时点不同），需用 `did2s::event_study` 或 `did_imputation`（Borusyak et al.）才正确。Stata 的 `eventdd` 与 `did_imputation`（Borusyak）也分开，**不要混用**。

