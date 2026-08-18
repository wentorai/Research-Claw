# PSM（倾向得分匹配）— 方法概览

## 1. 直觉

横截面观测数据中，处理与对照组在协变量 $X$ 上不平衡 → 直接比较有偏。PSM 用 $X$ 估计**倾向得分** $p(X) = \Pr(D=1|X)$，然后在 $p(X)$ 接近的处理与对照单位间配对，构造"准随机"的可比组。

ATT (Average Treatment Effect on Treated)：

$$\hat\tau_{ATT} = \frac{1}{N_1} \sum_{i: D_i = 1} \left( Y_i - \sum_j w(i,j) Y_j \right)$$

其中 $w(i,j)$ 是匹配权重（最近邻 / kernel / IPW）。

## 2. 关键假设

| 假设 | 说明 | 检验思路 |
|------|------|----------|
| **Unconfoundedness / CIA** | 给定 $X$，处理与潜在结果独立 | **不可直接检验**；需说服读者 $X$ 涵盖所有混淆变量 |
| **Common support / Overlap** | $0 < p(X) < 1$ | 倾向得分密度图、剔除超出支撑的样本 |
| **正确指定 p(X)** | logit/probit 设定不能错得离谱 | 平衡检验、生成倾向分时纳入交互项与多项式 |

## 3. PSM 的现代批评 (King-Nielsen 2019)

PSM 在大样本下匹配越精细，反而**增加**模型依赖与不平衡（"PSM Paradox"）。**首选替代**：

- **CEM (Coarsened Exact Matching)** — 在 $X$ 的粗化网格上做精确匹配
- **Mahalanobis distance matching**
- **Entropy balancing** — 直接对协变量矩做权重平衡，不估计倾向分
- **Doubly Robust / AIPW** — IPW × 回归调整，任一正确即一致

学界共识：PSM 仅作为基本对照；同时报告 CEM / entropy balancing / DR 至少一个。

## 4. 核心估计变体

| 方法 | Stata | R | Python |
|------|-------|---|--------|
| 1:1 / 1:k 最近邻 | `psmatch2`, `teffects psmatch` | `MatchIt(method="nearest")` | `causalml.match.NearestNeighborMatch` |
| Caliper 卡尺 | `psmatch2 ..., caliper(0.05)` | `MatchIt(caliper=0.2)` | 同上 + `caliper` |
| Kernel matching | `psmatch2 ..., kernel` | `MatchIt(method="full")` 近似 | `causalml.match.KernelDensityMatch` |
| IPW | `teffects ipw` | `WeightIt`, `MatchIt(method="cardinality")` | `dowhy`, `econml.dml` |
| AIPW / DR | `teffects aipw` | `WeightIt + lm` | `econml.dr.LinearDRLearner` |
| Entropy balancing | `ebalance` | `WeightIt(method="ebal")` | — (手写或 rpy2) |
| Doubly ML | — | `DoubleML` | `DoubleML`, `econml` |

## 5. 中国情境注意点

- **样本规模**：CSMAR 上市公司 ~5000 家，处理样本可能只有几百；1:1 最近邻 + caliper 0.01 后剩样本可能 < 100。**先看样本量后选方法**。
- **行业 / 年份维度**：常见做法是"行业-年份内匹配"（exact matching on industry × year），即同行业同年份内做 PSM。Stata: `psmatch2 ..., common ate exact(industry year)`. 这一做法在中国管理学/会计学论文几乎是标配。
- **协变量必须先于处理**：以处理时点 t 为基准，$X$ 用 t-1 期值，避免 post-treatment bias。
- **倾向分模型设定**：常用 logit 含规模 (lnAsset)、杠杆、年龄、ROA、Tobin Q、行业、年份。
- **平衡报告必备**：标准化均值差 (SMD) < 0.1 视为平衡，> 0.25 不可接受。
- **常见陷阱**：把"是否上市"当处理 → 显然 selection-on-unobservables，PSM 解决不了；改用 IV 或 DID。

## 6. 输出报告应该包含

1. **匹配前后协变量平衡表**：处理 / 对照均值、SMD、t-test
2. **倾向分密度图**：处理 vs 对照，匹配前后对比
3. **共同支撑** (off-support 单位数)
4. **ATT 估计**：1:1 最近邻 + 三种稳健性 (caliper / kernel / Mahalanobis / CEM)
5. **Rosenbaum bounds**（敏感性分析）— `rbounds` (Stata) / `rbounds` (R)
6. **PSM-DID** 联合（中国论文最常用：先 PSM 选样本，再 DID 估计）
7. **DR / AIPW 作为稳健性主张**——回应 King-Nielsen
