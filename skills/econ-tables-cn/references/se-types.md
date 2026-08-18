# SE 类型大全

经管研究最常见的 SE 类型及其适用场景、Stata/R/Python 实现。**错用 SE 是审稿人最常见的拒稿理由之一**。

## 1. Classical (Homoskedastic) SE

- **公式**：`Var(β) = σ² (X'X)⁻¹`
- **假设**：误差项独立同方差
- **现实**：基本不成立，只在教科书出现
- **报告**：经管/金融论文几乎不再用

## 2. Robust (Heteroskedastic-Consistent) SE

- 又称 White / Huber-White / HC0–HC3
- **假设**：异方差但独立
- **建议**：HC1（小样本修正）；Stata 默认 HC1，R `sandwich::vcovHC` 默认 HC3
- **何时用**：截面数据 + 没有明显聚类结构
- Stata: `reg y x, robust`
- R: `lmtest::coeftest(m, vcov=sandwich::vcovHC(m, "HC1"))`
- Python: `sm.OLS(y, X).fit(cov_type="HC1")`

## 3. Clustered SE（最常用）

### 3.1 单层聚类

- **公式**：`Var(β) = (X'X)⁻¹ (Σ_g X_g'u_g u_g'X_g) (X'X)⁻¹`
- **何时用**：观测值在某一维度（公司、行业、地区）相关
- **何时按 firm 聚类**：公司层 panel 数据，关心残差在同一公司不同年份的相关
- **何时按 year 聚类**：宏观冲击影响所有公司当年的 y
- Stata: `reg y x, vce(cluster firm)`
- R: `fixest::feols(y ~ x, data=d, cluster=~firm)`
- Python: `sm.OLS(y, X).fit(cov_type="cluster", cov_kwds={"groups": d.firm})`

### 3.2 双向聚类（two-way clustering）

- **何时用**：同时担心公司维度 + 时间维度残差相关
- **金融经管几乎默认必报**（Petersen 2009 RFS 经典文章后）
- Stata: `reg y x, vce(cluster firm year)` 或 `reghdfe y x, absorb(...) vce(cluster firm year)`
- R: `fixest::feols(y ~ x | firm + year, data=d, cluster=~firm+year)`
- Python: `linearmodels.PanelOLS(y, X, entity_effects=True).fit(cov_type="clustered", cluster_entity=True, cluster_time=True)`

### 3.3 聚类层级选择决策树

| 数据结构 | 推荐聚类 |
|---|---|
| 公司-年 panel | firm + year（双向） |
| 公司-月 panel | firm + month（双向） |
| 单期截面，分行业 | industry |
| 国家-年 panel | country + year |
| 个人-时间 panel | person + time |
| 实验数据，分组随机 | 分组层 |

**经验法则**：聚类到"处理变异（identifying variation）的层级"。如果 treatment 在 industry 层变化，就按 industry 聚类。

## 4. Driscoll-Kraay SE

- **何时用**：宏观面板数据（国家 / 地区）+ 残差跨截面相关 + 时间序列相关
- **特点**：对横截面相关稳健 + AR 自相关稳健
- Stata: `xtscc y x, lag(2)`（user-written）
- R: `plm::vcovSCC(m, maxlag=2)`
- Python: `linearmodels` 不直接支持，需手动实现或用 `statsmodels` 配合

## 5. Newey-West SE

- **何时用**：单时间序列回归 + 残差自相关 + 异方差
- **lag 选 4(T/100)^(2/9)**（Newey-West 1994 原始建议）
- Stata: `newey y x, lag(4)`
- R: `sandwich::NeweyWest(m, lag=4)`
- Python: `sm.OLS(y, X).fit(cov_type="HAC", cov_kwds={"maxlags": 4})`

## 6. Bootstrap SE

- **何时用**：小样本 / 非线性变换的 SE / 聚类 + 小群组
- **Wild cluster bootstrap**：聚类 G < 30 必备（Cameron-Gelbach-Miller 2008）
- Stata: `boottest`（user-written，Roodman 实现）
- R: `fwildclusterboot::boottest(m, clustid="firm")`
- Python: `pyfixest` 支持

## 7. SE 类型在不同表格格式中的标注

报告 SE 时表注要明确，例如：

> "Robust standard errors clustered at the firm-year level are reported in parentheses."
> "Driscoll-Kraay standard errors with lag = 2 are reported in parentheses."
> "Wild cluster bootstrap p-values (1000 reps) are reported in brackets."

如果**括号 vs 方括号**含义不同，必须在表注说明：

- `( )` = SE
- `[ ]` = t-stat 或 p-value
- `{ }` = 95% CI

## 8. 选错 SE 的代价

| 错误 | 后果 |
|---|---|
| 该聚类不聚类 | SE 严重低估 → t 值虚高 → 假阳性 |
| 该双向聚类只单向 | SE 低估 30%+（金融数据） |
| 小样本聚类不修正 | 类型 I 错误率从 5% 到 15%+ |
| 时序数据用 robust 不用 NW | 自相关导致 SE 严重偏 |
