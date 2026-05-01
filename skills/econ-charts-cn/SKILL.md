---
name: econ-charts-cn
description: 经济学/金融学/管理学研究专用图表模板集，覆盖 12 种经管高频图表（系数图 / 事件研究 / Bin scatter / 边际效应 / 政策门槛响应 / 处理组地图 / Sankey 资金流 / 董事网络 / 政策事件时间序列 / 层次聚类热图 / 元分析森林图 / 多回归对比表），各 × Stata / R / Python 三语言模板。支持《经济研究》《管理世界》《Journal of Finance》《Management Science》4 种期刊样式切换。当用户需要绘制经管学术图表、对比多回归、做事件研究可视化、画政策评估处理组分布、或绘制金融网络时调用本 Skill。
tags: [econ, finance, management, charts, plotting, stata, r, python, panel-data, did, event-study]
version: 0.1.0
author: HaonanAlex
license: Apache-2.0
---

# econ-charts-cn — 经管研究专用图表模板集

本 Skill 为经济学、金融学、管理学领域的研究者提供 **12 类高频图表** × **Stata / R / Python 三语言**模板，并支持 4 种期刊样式（《经济研究》《管理世界》《Journal of Finance》《Management Science》）切换。

## What it does

- 覆盖经管研究 12 种高频图：系数对比 / 事件研究 / Bin scatter / 边际效应 / 政策门槛响应 / 处理组地图 / Sankey 资金流 / 董事会网络 / 政策事件时间序列 / 层次聚类热图 / 元分析森林图 / 多回归对比表
- 同一张图三种语言均给出可独立运行的最小模板
- 4 种期刊样式参数（字体 / 字号 / 颜色 / 线宽 / 图说位置）
- 经管色板（B&W / 政策类 / 金融类）
- 经管学者常犯错清单（双纵轴乱用 / 标签英文 / 颜色花哨 / 坐标轴零点等）
- Stata / R / Python 三语言互转 + 选用建议

## When to invoke

- 用户绘制经管学术图表（DiD 事件研究 / 多回归对比 / 政策处理组地图）
- 用户问"经济研究 / 管理世界 系数图怎么画"
- 用户做政策评估，需要可视化处理组空间分布
- 用户绘制金融网络（董事兼任 / 上市公司互联）
- 用户做元分析，需要森林图
- 用户在 Stata / R / Python 之间切换图表代码

## Files

```
econ-charts-cn/
├── SKILL.md
├── references/
│   ├── chart-types-overview.md           # 12 类图表概览 + 适用论文章节
│   ├── journal-styles.md                 # 4 期刊样式
│   ├── color-palettes.md                 # 经管色板
│   ├── workflow-stata-r-python.md        # 三语言互转 + 何时用哪个
│   └── common-mistakes.md                # 经管学者常犯错
├── templates/
│   ├── stata/                            # 6 个 .do 模板
│   ├── r/                                # 7 个 .R 模板
│   └── python/                           # 8 个 .py 模板
├── tests/
├── LICENSE
├── NOTICE
└── README.md
```

## Quick start

```bash
# 1. 看 12 类图概览，定位你要的图
open references/chart-types-overview.md

# 2. 看目标期刊样式
open references/journal-styles.md

# 3. 选语言 + 模板
cp templates/python/event_study.py ./my_event_study.py
python my_event_study.py     # 输出 my_event_study.pdf

# Stata
cp templates/stata/eventdd.do ./my_event.do
stata -b do my_event.do

# R
cp templates/r/event_study.R ./my_event.R
Rscript my_event.R
```

## 12 chart types

| # | 图表 | 适用章节 | Stata | R | Python |
|---|------|---------|-------|---|--------|
| 1 | 系数对比图 | 主回归 / 异质性 | coefplot.do | coefplot.R | coefplot.py |
| 2 | 事件研究 | DiD 主图 | eventdd.do | event_study.R | event_study.py |
| 3 | Bin scatter | 描述性 / RDD | binscatter.do | bin_scatter.R | bin_scatter.py |
| 4 | 边际效应 | 交互项 / 非线性 | margins_plot.do | marginal_effects.R | — |
| 5 | 政策门槛响应 | RDD / Bunching | bunching.do | — | — |
| 6 | 处理组地图 | 政策评估 | — | treatment_map_china.R | treatment_map.py |
| 7 | Sankey 资金流 | 资金 / 股权流向 | — | — | sankey.py |
| 8 | 董事网络 | 公司治理 | — | network_boards.R | network_directors.py |
| 9 | 政策事件时间序列 | 描述性 / 事件 | — | — | time_series_policy_events.py |
| 10 | 层次聚类热图 | 相关性 / 因子 | — | — | heatmap_clustered.py |
| 11 | 元分析森林图 | 综述 | — | forest_plot.R | — |
| 12 | 多回归对比表 | 主回归表 | multiple_regs_table.do | — | — |

## Core principles (TL;DR)

1. **三语言定位**：Stata 适合主回归 + 系数图（一行 `coefplot`）；R 适合事件研究 + 网络 + 地图（`fixest` / `igraph` / `sf`）；Python 适合多面板组合 + 复杂可视化（`matplotlib` / `geopandas` / `plotly`）
2. **期刊优先级**：先看 `journal-styles.md`，确定字体 / 字号 / 颜色，再写图
3. **黑白可读**：marker + linestyle 区分序列；`color-palettes.md` 给出 4 种 B&W 友好方案
4. **导出**：PDF 矢量 + 300 DPI；中文字体回退链 `Times New Roman → SimSun → Songti SC`
5. **经管特化**：DiD 基期空心圆；事件研究 `t = -1` 归零；coefplot 横向更易读

## Anti-patterns

详见 `references/common-mistakes.md`。最高频 5 条：

1. 多回归用 `outreg2` 出个表就完事，不画系数图（审稿人会问"你能不能给我一张图"）
2. 事件研究图基期没归零、没画零参考线
3. 处理组地图忘了说明"白色 = 控制组 / 灰色 = 处理组"
4. Sankey 资金流图节点过多（>20 个），完全无法阅读
5. 双纵轴用不同颜色再连线，制造视觉欺骗
