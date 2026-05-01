# PSM — Python 模板

## Setup

```bash
# pip install causalml econml DoubleML scikit-learn pandas numpy matplotlib
```

```python
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
```

## 1. 倾向分估计 + 1:1 最近邻匹配 — causalml

```python
from causalml.match import NearestNeighborMatch, create_table_one

df = pd.read_parquet("data/firm_2014.parquet")
covars = ["lnAsset", "leverage", "roa", "age", "tobinq"]

# 估倾向分
ps_model = LogisticRegression(max_iter=2000)
ps_model.fit(df[covars], df["D"])
df["pscore"] = ps_model.predict_proba(df[covars])[:, 1]

psm = NearestNeighborMatch(
    replace = False,
    ratio   = 1,
    caliper = 0.05,
    random_state = 42,
)
matched = psm.match(
    data        = df,
    treatment_col = "D",
    score_cols  = ["pscore"],
)
print(f"Matched sample: {len(matched)} (treated {matched['D'].sum()})")
```

## 2. 平衡诊断

```python
# Standardized mean difference
def smd(x_t, x_c):
    return (x_t.mean() - x_c.mean()) / np.sqrt(0.5 * (x_t.var() + x_c.var()))

rows = []
for v in covars:
    pre  = smd(df.loc[df["D"]==1, v],     df.loc[df["D"]==0, v])
    post = smd(matched.loc[matched["D"]==1, v],
               matched.loc[matched["D"]==0, v])
    rows.append({"var": v, "SMD_before": pre, "SMD_after": post})
balance = pd.DataFrame(rows)
print(balance.round(3))
# 阈值：|SMD| < 0.1 视为平衡

# Love plot
plt.figure(figsize=(6, 4))
y = np.arange(len(covars))
plt.scatter(balance["SMD_before"].abs(), y, label="Before", marker="o")
plt.scatter(balance["SMD_after"].abs(),  y, label="After",  marker="s")
plt.axvline(0.1, ls="--", color="gray")
plt.yticks(y, covars); plt.xlabel("|SMD|"); plt.legend(); plt.show()
```

## 3. 倾向分密度图

```python
fig, ax = plt.subplots(1, 2, figsize=(10, 4), sharey=True)
for split, name in [(df, "Before"), (matched, "After")]:
    a = ax[0] if name == "Before" else ax[1]
    a.hist(split.loc[split["D"]==1, "pscore"], bins=30, alpha=0.5, label="Treated")
    a.hist(split.loc[split["D"]==0, "pscore"], bins=30, alpha=0.5, label="Control")
    a.set_title(name); a.set_xlabel("pscore"); a.legend()
plt.show()
```

## 4. ATT 估计 (匹配后回归)

```python
import statsmodels.formula.api as smf
fit = smf.ols("Y ~ D + lnAsset + leverage + roa + age + tobinq",
              data=matched).fit(cov_type="HC1")
print(fit.summary().tables[1])
# 也可：matched.groupby("D")["Y"].mean().diff()
```

## 5. IPW / AIPW — econml

```python
from econml.dr import LinearDRLearner
from sklearn.ensemble import RandomForestRegressor, RandomForestClassifier

est = LinearDRLearner(
    model_propensity = RandomForestClassifier(n_estimators=200, random_state=42),
    model_regression = RandomForestRegressor (n_estimators=200, random_state=42),
    discrete_outcome = False,
    cv = 5,
)
est.fit(
    Y = df["Y"].values,
    T = df["D"].values,
    X = df[covars].values,
)
ate = est.ate(df[covars].values)
print(f"ATE (DR) = {ate:.3f}")
print(est.ate_inference(df[covars].values).summary_frame())
```

## 6. DoubleML (cross-fitted DR — Chernozhukov et al. 2018)

```python
import doubleml as dml
from sklearn.ensemble import RandomForestRegressor, RandomForestClassifier

dml_data = dml.DoubleMLData(
    df, y_col="Y", d_cols="D", x_cols=covars,
)
ml_g = RandomForestRegressor (n_estimators=200, random_state=42)
ml_m = RandomForestClassifier(n_estimators=200, random_state=42)

dml_irm = dml.DoubleMLIRM(
    dml_data, ml_g=ml_g, ml_m=ml_m,
    score = "ATTE",          # ATT
    n_folds = 5,
)
dml_irm.fit()
print(dml_irm.summary)
```

## 7. PSM-DID

```python
# Step 1: 截面 PSM (t-1 期)
df_pre = panel.query("year == 2014")
ps = LogisticRegression(max_iter=2000).fit(df_pre[covars], df_pre["D"])
df_pre = df_pre.assign(pscore = ps.predict_proba(df_pre[covars])[:, 1])
matched_pre = NearestNeighborMatch(ratio=1, caliper=0.05).match(
    df_pre, treatment_col="D", score_cols=["pscore"])

# Step 2: 在面板上跑 DID（在配对样本上）
keep_ids = matched_pre["firm_id"].unique()
panel_m  = panel[panel["firm_id"].isin(keep_ids)].copy()
panel_m["post"] = (panel_m["year"] >= 2015).astype(int)
panel_m["did"]  = panel_m["D"] * panel_m["post"]

import pyfixest as pf
m = pf.feols("Y ~ did + lnAsset + leverage | firm_id + year",
             data = panel_m, vcov = {"CRV1": "industry"})
m.summary()
```

## 8. Rosenbaum bounds (近似实现)

```python
# Python 端无成熟 rbounds 包。最简单的 Wilcoxon-rank 思路：
from scipy.stats import wilcoxon

treated = matched.loc[matched["D"]==1, "Y"].values
control = matched.loc[matched["D"]==0, "Y"].values
diffs   = treated - control
stat, p = wilcoxon(diffs)
print(f"Wilcoxon p (Gamma=1): {p:.4f}")

# 在 Gamma > 1 下放宽 p：扫一下 Gamma = 1.0 ~ 2.0
def rosenbaum_p(diffs, gamma):
    # 单边上界：p_upper(gamma)；这里用近似公式（仅示意）
    n = len(diffs)
    pos = (diffs > 0).sum()
    p   = gamma / (1 + gamma)
    from scipy.stats import binom
    return 1 - binom.cdf(pos - 1, n, p)

for g in [1.0, 1.2, 1.5, 1.8, 2.0]:
    print(f"Gamma = {g}: p_upper = {rosenbaum_p(diffs, g):.4f}")
```

> 严格 Rosenbaum bounds 推荐用 R `rbounds` 或 Stata `rbounds`；Python 端目前无完全等价实现。

## 输出解读 tips

- `causalml` 的 `NearestNeighborMatch` 返回**已匹配的子样本** DataFrame；要再跑回归才得 ATT 的 CI。
- **DoubleML** 是当前 Python 端做因果识别最稳的工具：cross-fitting + ML nuisance，自动给 ATT/ATE 的 SE 和 CI；推荐作为论文主表的稳健性栏。
- **不要全靠 1:1 + caliper**：报告 1:1 / 1:4 / kernel-like (full match approximation) / DR 至少 4 列。
- 平衡报告必带 SMD before/after 表与 love plot。
