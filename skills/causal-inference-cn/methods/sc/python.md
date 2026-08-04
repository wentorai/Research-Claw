# SC — Python 模板

## Setup

```bash
# pip install pysyncon SparseSC pandas numpy matplotlib
# pysyncon: ADH-style SCM + AugSCM + RobustSCM
# SparseSC: 罚化 SCM (Microsoft Research)，适合高维控制池
```

```python
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from pysyncon import Dataprep, Synth, AugSynth, PenalizedSynth
```

## 1. 基础 SCM — pysyncon

```python
df = pd.read_parquet("data/region_panel.parquet")
# 长格式：region_id, region_name, year, lnGDP, pop_density, urb_rate, ...

dp = Dataprep(
    foo                    = df,
    predictors             = ["pop_density", "urb_rate",
                              "sec_industry_share", "fdi_share"],
    predictors_op          = "mean",
    time_predictors_prior  = range(2003, 2013),
    special_predictors     = [
        ("lnGDP", [2003], "mean"),
        ("lnGDP", [2007], "mean"),
        ("lnGDP", [2012], "mean"),
    ],
    dependent              = "lnGDP",
    unit_variable          = "region_id",
    time_variable          = "year",
    treatment_identifier   = 11,                          # 北京
    controls_identifier    = [u for u in df["region_id"].unique() if u != 11],
    time_optimize_ssr      = range(2003, 2013),
)

scm = Synth()
scm.fit(dataprep=dp)

print("Pre-RMSPE :", scm.pre_rmspe)
print("Post-RMSPE:", scm.post_rmspe)
print("\nWeights (W):"); print(scm.weights().sort_values(ascending=False).head(10))

# 主图
scm.path_plot(time_period=range(2003, 2019),
              treatment_time=2013)
plt.title("Beijing vs Synthetic Beijing")
plt.show()

scm.gaps_plot(time_period=range(2003, 2019), treatment_time=2013)
plt.show()
```

## 2. In-space placebo

```python
units = list(df["region_id"].unique())
gaps  = {}

for u in units:
    dp_u = Dataprep(
        foo                    = df,
        predictors             = ["pop_density", "urb_rate",
                                  "sec_industry_share", "fdi_share"],
        predictors_op          = "mean",
        time_predictors_prior  = range(2003, 2013),
        special_predictors     = [("lnGDP", [2003], "mean"),
                                  ("lnGDP", [2007], "mean"),
                                  ("lnGDP", [2012], "mean")],
        dependent              = "lnGDP",
        unit_variable          = "region_id",
        time_variable          = "year",
        treatment_identifier   = u,
        controls_identifier    = [v for v in units if v != u],
        time_optimize_ssr      = range(2003, 2013),
    )
    try:
        m = Synth(); m.fit(dataprep=dp_u)
        gaps[u] = m.gaps
    except Exception:
        continue

# 画 spaghetti
plt.figure(figsize=(8, 5))
for u, g in gaps.items():
    plt.plot(g.index, g.values,
             color="lightgray" if u != 11 else "red",
             lw=0.7 if u != 11 else 2,
             label="Beijing" if u == 11 else None)
plt.axhline(0, ls="--", color="black")
plt.axvline(2013, ls="--", color="black")
plt.title("In-space placebo")
plt.legend(); plt.show()

# RMSPE 比 p 值
def rmspe_ratio(g, T0=2012):
    pre  = g.loc[g.index <= T0]
    post = g.loc[g.index >  T0]
    return np.sqrt((post**2).mean() / (pre**2).mean())

ratios = {u: rmspe_ratio(g) for u, g in gaps.items()}
ranked = sorted(ratios.items(), key=lambda kv: -kv[1])
rank_treated = next(i for i, (u, _) in enumerate(ranked, 1) if u == 11)
p_val = rank_treated / len(ranked)
print(f"p-value (RMSPE ratio): {p_val:.3f}")
```

## 3. Augmented SCM (pre fit 不够时)

```python
asc = AugSynth()
asc.fit(dataprep=dp, lambda_=0.1)        # ridge augmentation
print("ATT:", asc.att())
asc.path_plot(time_period=range(2003, 2019), treatment_time=2013)
```

## 4. Penalized SCM (高维控制池) — SparseSC

```python
import SparseSC

# Y 形状: (units, time)；处理单位最后一行
units = sorted(df["region_id"].unique())
Y = (df.pivot(index="region_id", columns="year", values="lnGDP")
       .loc[units]
       .values)

# 重排：处理单位放最后
treat_idx = units.index(11)
order = [i for i in range(len(units)) if i != treat_idx] + [treat_idx]
Y = Y[order]
T0 = list(df["year"].unique()).index(2013)   # 处理时点列下标

est = SparseSC.fit_fast(
    features = Y[:, :T0],
    targets  = Y[:, :T0],
    treated_units = [Y.shape[0] - 1],
)
synth_post = est.predict(Y[:, T0:])
gap = Y[-1, T0:] - synth_post[-1, :]
print("Post-treatment gaps:", gap)
```

## 5. Synthetic DID — Python (synthdid-py)

```python
# pip install synthdid
from synthdid.synthdid import Synthdid

# Y: matrix (units x time), treated_index=最后 N1 行, post_index=最后 T1 列
N0, T0 = sum_controls, len_pre
sdid = Synthdid(Y, N0=N0, T0=T0)
res = sdid.fit()
print("ATT:", res.att, "SE (placebo):", res.se_placebo)
res.plot()
```

## 输出解读 tips

- `pysyncon` API 与 R `Synth` 几乎一对一；权重输出可直接 `to_latex()`。
- **当 Python 端报错 / 数值不稳**：通常是某些控制单位在 pre 期有缺失值——检查面板是否真平衡 (`df.groupby('region_id')['year'].count().describe()`).
- **SparseSC** 的 `fit_fast` 在控制池 > 30 时显著加速；权重稀疏，更易解释。
- 严格论文级，仍建议 R 端 `synthdid` + `augsynth` 做最终主表，Python 端做探索。
- 主图三件套：path plot、gap plot、in-space placebo spaghetti。
