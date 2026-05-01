# IV — Python 模板

## Setup

```bash
# pip install linearmodels pandas numpy statsmodels pyfixest
```

```python
import numpy as np
import pandas as pd
from linearmodels.iv import IV2SLS, IVLIML, IVGMM
import pyfixest as pf
import statsmodels.api as sm
```

## 1. 基础 2SLS — linearmodels

```python
df = pd.read_parquet("data/iv_sample.parquet")

# 公式形式：Y ~ exog + [endog ~ instruments]
m_iv = IV2SLS.from_formula(
    "Y ~ 1 + x1 + x2 + [D ~ Z1 + Z2]",
    data = df,
).fit(cov_type="robust")
print(m_iv.summary)

# 关键属性
m_iv.first_stage              # 第一阶段表
m_iv.first_stage.diagnostics  # 含 Partial F、Cragg-Donald
m_iv.sargan                   # Sargan / Hansen J
m_iv.basmann                  # Basmann J
m_iv.wu_hausman()             # Hausman 内生性
```

## 2. OLS vs 2SLS

```python
import statsmodels.formula.api as smf
m_ols = smf.ols("Y ~ D + x1 + x2", data=df).fit(cov_type="HC1")

import pandas as pd
out = pd.DataFrame({
    "OLS":    [m_ols.params["D"],  m_ols.bse["D"],  m_ols.pvalues["D"]],
    "2SLS":   [m_iv.params["D"],   m_iv.std_errors["D"], m_iv.pvalues["D"]],
}, index=["coef", "se", "p"])
print(out.round(3))
```

## 3. 高维 FE + IV — pyfixest

```python
m_fe = pf.feols(
    "Y ~ x1 + x2 | firm_id + year | D ~ Z1 + Z2",
    data    = df,
    vcov    = {"CRV1": "province_id"},
)
m_fe.summary()
# pyfixest 输出 Kleibergen-Paap F 与 Wald
```

## 4. Olea-Pflueger 有效 F（手算稳健 F + 一阶段诊断）

```python
fs = m_iv.first_stage
print(fs.diagnostics)
# rsquared.uncentered, partial.rsquared, shea.rsquared,
# partial.f.stat (异方差稳健), kleibergen.paap.rk

# 经验阈值：partial F > 10 (Stock-Yogo) / > 23.1 (OP 5% bias)
```

更严格的 Olea-Pflueger 实现需手写或 `rpy2` 调 R 的 `ivDiag`。

## 5. Anderson-Rubin 弱-IV 稳健 CI

```python
from linearmodels.iv import IV2SLS

# AR 检验：在 H0: beta_D = b 下，把 (Y - b*D) 对 Z 回归；F 即 AR 统计量
def anderson_rubin_ci(df, b_grid, alpha=0.05):
    keep = []
    n = len(df)
    for b in b_grid:
        df_ar = df.assign(Y_adj = df["Y"] - b * df["D"])
        m = sm.OLS(df_ar["Y_adj"],
                   sm.add_constant(df_ar[["Z1","Z2","x1","x2"]])
                  ).fit(cov_type="HC1")
        # 联合检验 Z1=Z2=0
        F = m.f_test("Z1 = Z2 = 0").fvalue
        # 临界值：F(2, n-k) at alpha
        from scipy.stats import f as fdist
        k = 5
        crit = fdist.ppf(1 - alpha, 2, n - k)
        if F < crit:
            keep.append(b)
    return min(keep), max(keep)

ar_lo, ar_hi = anderson_rubin_ci(df, np.linspace(-2, 2, 401))
print(f"AR 95% CI = [{ar_lo:.3f}, {ar_hi:.3f}]")
```

## 6. 简化型 (Reduced Form)

```python
m_rf = smf.ols("Y ~ Z1 + Z2 + x1 + x2", data=df).fit(cov_type="HC1")
print(m_rf.summary().tables[1])
```

## 7. LIML / GMM (弱 IV / 异方差更稳健)

```python
m_liml = IVLIML.from_formula(
    "Y ~ 1 + x1 + x2 + [D ~ Z1 + Z2]", data=df
).fit(cov_type="robust")

m_gmm = IVGMM.from_formula(
    "Y ~ 1 + x1 + x2 + [D ~ Z1 + Z2]", data=df
).fit(cov_type="robust", iter_limit=10)
```

## 8. 安慰剂

```python
m_pl = IV2SLS.from_formula(
    "Y_placebo ~ 1 + x1 + x2 + [D ~ Z1 + Z2]", data=df
).fit(cov_type="robust")
print(m_pl.params["D"], m_pl.pvalues["D"])
```

## 输出解读 tips

- `linearmodels` 是 Python 端做 IV 的事实标准；`pyfixest` 在高维 FE + IV 场景更便捷。
- **诊断字段位置**（IV2SLS）：
  - `first_stage.diagnostics` → 第一阶段 F、partial R²、Cragg-Donald
  - `.sargan` / `.basmann` → 过度识别
  - `.wu_hausman()` → 内生性
- 报告 4 列：OLS, 2SLS, First-stage F, RF (Z 对 Y)。
- Python 端目前**没有像 R `ivDiag` 那样集成的 OP-F / tF**——做严格论文级稳健性时建议 `rpy2` 调 R。
