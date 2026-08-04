# 12 类经管研究高频图表概览

本文件给出 12 类经管研究中最常用的图表，每类附**适用场景**、**论文章节归属**、**关键审稿要点**与**三语言模板入口**。

---

## 1. 系数对比图（Coefficient Plot）

**典型用法**：把多组回归（基准 / 加控制 / 加固定效应 / 子样本）的核心系数及其 95% CI 横向并排展示。

**适用章节**：第 5 节"主回归结果"、第 6 节"稳健性"、第 7 节"异质性"。

**审稿要点**：
- 必须画 95% 或 90% CI 误差棒；不要只画点
- 横向展示比纵向更紧凑，名字长也不会重叠
- 若样本量差异大，需在每行后面加 N
- 0 参考线必须画

**模板**：`stata/coefplot.do` / `r/coefplot.R` / `python/coefplot.py`

---

## 2. 事件研究图（Event Study）

**典型用法**：DiD 中展示处理效应在政策实施前后逐期的动态变化。

**适用章节**：DiD 主图（通常紧跟主表）、平行趋势检验。

**审稿要点**：
- 基期（一般 t = -1）必须归零，画空心圆区分
- 0 处必须画水平参考线
- 政策时点（t = 0 之前）画垂直虚线
- 95% CI 必须画
- pre-trend 部分若显著，论文死期已到（要解释）

**模板**：`stata/eventdd.do`（或 `did_imputation`） / `r/event_study.R`（fixest::feols + iplot） / `python/event_study.py`

---

## 3. Bin Scatter

**典型用法**：把巨量散点（>10000 obs）按 X 分箱后取均值，看 Y vs X 的非参形状。

**适用章节**：描述性证据、识别策略论证（RDD 跳跃可视化）、机制分析。

**审稿要点**：
- 必须报告分箱数（一般 20–50）
- 是否控制了协变量要写明
- 若做 RDD 风格，必须在 cutoff 前后分别拟合
- Cattaneo et al. (2024) 的 `binsreg` / `binscatter2` 是当前标准

**模板**：`stata/binscatter.do`（Stepner 包，或 `binsreg`） / `r/bin_scatter.R`（binsreg） / `python/bin_scatter.py`

---

## 4. 边际效应图（Marginal Effects）

**典型用法**：交互项或非线性模型（probit / logit / 二次项），把"X 对 Y 的边际效应在 Z 不同取值下"画出来。

**适用章节**：异质性、调节效应、非线性识别。

**审稿要点**：
- 必须画 CI；不要只画点估计
- X 轴是调节变量 Z 的取值；Y 轴是 dy/dx
- Z 的取值范围要在数据 5–95 分位之间
- 给出 Z 的边际分布（rug plot 或下方直方图）

**模板**：`stata/margins_plot.do`（margins + marginsplot） / `r/marginal_effects.R`（ggeffects） / 暂无 Python 模板（参见 `statsmodels` 文档）

---

## 5. 政策门槛响应 / Bunching

**典型用法**：在政策门槛（如税率断点 / 补贴申请条件）处，画申报值的密度，看是否在门槛附近"扎堆"。

**适用章节**：避税 / 补贴申报研究的识别策略。

**审稿要点**：
- 反事实分布要给出（多项式拟合排除 bunching window）
- bunching mass 估计 + 弹性反推必须有
- 95% bootstrap CI

**模板**：`stata/bunching.do`（Chetty et al. 风格自实现）

---

## 6. 处理组地图（Treatment Map）

**典型用法**：政策评估中展示处理组（实施政策的省 / 市 / 县）的空间分布。

**适用章节**：政策背景、识别策略前置。

**审稿要点**：
- 中国地图必须有南海九段线
- 处理组用深色填充，控制组浅色或白色，图例要注明
- 时间维度可用多面板（2010 / 2015 / 2020）
- 不要用红绿配色（色盲 + 政治敏感）

**模板**：`r/treatment_map_china.R`（sf + 中国行政区划） / `python/treatment_map.py`（geopandas）

---

## 7. Sankey 资金流向图

**典型用法**：展示资金 / 股权 / 客户从一组实体流向另一组实体的体量。

**适用章节**：金融机构关联交易、产业链上下游、并购重组。

**审稿要点**：
- 节点不要超过 20 个，否则无法阅读
- 流量粗细必须严格按金额比例
- 颜色按"流出方"分组

**模板**：`python/sankey.py`（plotly）

---

## 8. 董事 / 公司网络图

**典型用法**：董事兼任网络（独立董事跨多家公司）、上市公司股权关联网络。

**适用章节**：公司治理、机构互联性、系统性风险。

**审稿要点**：
- 节点大小用度中心性（degree centrality）编码
- 节点颜色用社区检测（Louvain / Leiden）结果编码
- 必须报告：N 节点、E 边、平均度、聚类系数

**模板**：`r/network_boards.R`（igraph） / `python/network_directors.py`（networkx）

---

## 9. 政策事件时间序列

**典型用法**：在时间序列上叠加多个政策事件竖线，看变量在政策附近的反应。

**适用章节**：描述性证据、宏观背景。

**审稿要点**：
- 政策事件名 + 日期必须标在图内或图注
- 竖线建议虚线 + 灰色，不要喧宾夺主
- 若事件多于 5 个，考虑分面板

**模板**：`python/time_series_policy_events.py`

---

## 10. 层次聚类相关性热图

**典型用法**：因子集 / 公司特征集的相关性矩阵，做层次聚类后重排序。

**适用章节**：因子选择、变量定义附录。

**审稿要点**：
- 用 diverging colormap（红蓝 / 灰白），中点为 0
- 必须显示数值（小矩阵时）
- 聚类后保留 dendrogram

**模板**：`python/heatmap_clustered.py`（seaborn clustermap）

---

## 11. 元分析森林图（Forest Plot）

**典型用法**：综述类文章汇总多个研究的效应量。

**适用章节**：综述 / Meta-analysis 主图。

**审稿要点**：
- 每个研究一行，点估计 + CI
- 底部加汇总（diamond）
- 异质性指标（I², τ²）必须报告

**模板**：`r/forest_plot.R`（forestplot 包）

---

## 12. 多回归一键对比表

**典型用法**：把 4–6 列回归（基准 / + 控制 / + FE / 子样本）的系数 + 标准误一键导出三线表。

**适用章节**：所有需要回归表的章节。

**审稿要点**：
- 主系数加 ★（10/5/1%）
- 标准误括号 / 异方差稳健或聚类必须注明
- N、R²、控制变量是否包含必须有

**模板**：`stata/multiple_regs_table.do`（estout / outreg2）

---

## 选用决策树

```
要画什么？
├── 多个回归对比同一个系数 → coefplot
├── DiD / 政策动态效应     → event_study
├── 描述性大样本散点         → bin_scatter
├── 交互项 / 非线性边际效应 → margins_plot
├── 政策门槛 / 申报扎堆     → bunching
├── 政策处理组分布           → treatment_map
├── 资金 / 股权流向          → sankey
├── 董事 / 公司互联          → network_boards
├── 时间序列 + 多政策事件   → time_series_policy_events
├── 相关性矩阵 + 聚类       → heatmap_clustered
├── 多研究效应量汇总         → forest_plot
└── 多回归一键导表           → multiple_regs_table
```

## 经管图表通则

- 单栏图宽 ≤ 8.5 cm；双栏 ≤ 17 cm
- 字号：标题 10–11 pt，坐标轴 9–10 pt，刻度 8–9 pt
- PDF 矢量；中文字体回退链 Times → SimSun → Songti SC
- 注释 / 数据来源置于图下，"注：……数据来源：……"
