# DiD — Python 模板

## Setup

```bash
# pip install pandas numpy linearmodels matplotlib statsmodels pyfixest doubleml
```

```python
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from linearmodels.panel import PanelOLS
import pyfixest as pf  # fixest 在 Python 上的镜像
```

## 1. 标准 TWFE — linearmodels.PanelOLS

```python
df = pd.read_parquet("data/panel.parquet")
df["post"] = (df["year"] >= df["treat_year"]).astype(int)
df.loc[df["treat_year"].isna(), "post"] = 0
df["did"] = df["treated"] * df["post"]

panel = df.set_index(["firm_id", "year"])
mod = PanelOLS.from_formula(
    "lnY ~ did + x1 + x2 + EntityEffects + TimeEffects",
    data=panel,
)
res = mod.fit(cov_type="clustered", clusters=panel["province_id"])
print(res.summary)
```

## 1b. 同样回归 — pyfixest（语法与 R fixest 几乎一致）

```python
m_twfe = pf.feols(
    "lnY ~ did + x1 + x2 | firm_id + year",
    data    = df,
    vcov    = {"CRV1": "province_id"},
)
m_twfe.summary()
```

## 2. 事件研究

```python
df["event_t"] = df["year"] - df["treat_year"]
df.loc[df["treat_year"].isna(), "event_t"] = np.nan
df["event_t"] = df["event_t"].clip(lower=-5, upper=5)

m_event = pf.feols(
    "lnY ~ i(event_t, ref=-1) + x1 + x2 | firm_id + year",
    data = df,
    vcov = {"CRV1": "province_id"},
)
m_event.iplot()
plt.title("Event study around policy")
plt.xlabel("Years from treatment")
plt.show()
```

## 3. 交错处理：Callaway & Sant'Anna 实现

Python 端尚无与 R `did` 完全等价的成熟包；常用方案：

- `differences` (PyPI): C&S, Sun-Abraham
- `csdid` (PyPI port)
- 直接 R 调用：通过 `rpy2` 调 `did::att_gt`

最小示例（`differences`）：

```python
# pip install differences
from differences import ATTgt

df["gvar"] = df["treat_year"].fillna(0).astype(int)
att = ATTgt(data=df, cohort_name="gvar")
att.fit(formula="lnY ~ x1 + x2",
        control_group="not_yet_treated",
        est_method="dr",
        cluster_var="province_id")
print(att.aggregate("event"))
```

## 4. 平行趋势 Wald 检验

```python
pre_terms = [c for c in m_event.coef().index if "C(event_t)" in c and "-" in c]
m_event.wald_test(pre_terms)  # H0: 所有 pre 期 == 0
```

## 5. 安慰剂（随机化处理时点）

```python
rng = np.random.default_rng(42)
units  = df["firm_id"].unique()
years  = np.arange(df["year"].min(), df["year"].max() + 1)
B      = 500
betas  = []

for b in range(B):
    fake_treated = rng.choice(units, size=int(0.3 * len(units)), replace=False)
    fake_year    = pd.Series(
        rng.choice(years, size=len(fake_treated)),
        index=fake_treated, name="fake_year",
    )
    d2 = df.merge(fake_year, left_on="firm_id", right_index=True, how="left")
    d2["fake_post"] = (d2["year"] >= d2["fake_year"]).astype(int).fillna(0)
    d2["fake_did"]  = d2["fake_year"].notna().astype(int) * d2["fake_post"]
    res_b = pf.feols("lnY ~ fake_did | firm_id + year", data=d2)
    betas.append(res_b.coef()["fake_did"])

import seaborn as sns
sns.histplot(betas, kde=True)
plt.axvline(x=res.params["did"], color="red")
plt.title(f"Placebo distribution (B={B})")
```

## 6. 输出解读 tips

- `linearmodels` 的 `EntityEffects + TimeEffects` 等于 TWFE，但**双向聚类**需 `cov_type="clustered"` + `clusters=` 二维数组。
- `pyfixest` 直接接 R fixest 的语法，迁移成本低；社区活跃度高。
- **不要在 Python 端纠结 csdid 性能**——成熟实现仍以 R `did` 为主，必要时 `rpy2` 桥接。
- 报告模板：主回归 (TWFE) + 事件研究图 + C&S 总 ATT + 安慰剂直方图。
