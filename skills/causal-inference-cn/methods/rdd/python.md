# RDD — Python 模板

## Setup

```bash
# pip install rdrobust pandas numpy matplotlib
# rdrobust 是官方 Python port，与 R/Stata 同作者团队 (Calonico-Cattaneo-Titiunik)
```

```python
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from rdrobust import rdrobust, rdplot, rdbwselect
# 密度检验：当前官方 Python 端无 rddensity 直接对应；
# 替代：手写 McCrary，或用 rpy2 桥接 R rddensity
```

## 1. RDD 散点图

```python
df = pd.read_parquet("data/rdd_sample.parquet")
# X 已中心化为 X - cutoff，cutoff = 0

rdplot(
    y = df["Y"].values,
    x = df["X"].values,
    c = 0, p = 1,
    binselect = "esmv",
    title  = "RD plot, p=1",
    x_label = "Score - cutoff",
    y_label = "Y",
)
plt.show()
```

## 2. Sharp RDD 主估计

```python
res = rdrobust(
    y = df["Y"].values,
    x = df["X"].values,
    c = 0, p = 1,
    kernel   = "triangular",
    bwselect = "mserd",
)
print(res)

# 关键字段
print("Coefs (Conv / BC / Robust):", res.coef.values.ravel())
print("CIs:", res.ci.values)
print("Bandwidth h:", res.bws.iloc[0, 0])
print("Eff. N (left, right):", res.N_h.values)
```

## 3. Fuzzy RDD

```python
res_fz = rdrobust(
    y = df["Y"].values,
    x = df["X"].values,
    fuzzy = df["D"].values,
    c = 0, p = 1,
    kernel = "triangular", bwselect = "mserd",
)
print(res_fz)
```

## 4. McCrary 密度检验（手写最简版）

```python
def mccrary_test(x, cutoff=0.0, bw=None, n_bins=40):
    """Returns (tau, se, t-stat) for log-density jump at cutoff."""
    if bw is None:
        bw = 2 * np.std(x) * len(x) ** (-1/5)
    bins   = np.linspace(cutoff - bw, cutoff + bw, n_bins + 1)
    counts, edges = np.histogram(x, bins=bins)
    mids   = 0.5 * (edges[:-1] + edges[1:])
    left   = mids <  cutoff
    right  = mids >= cutoff
    # log-density on each side
    f_l = np.log(counts[left]  / (len(x) * np.diff(edges)[left]  + 1e-9) + 1e-9)
    f_r = np.log(counts[right] / (len(x) * np.diff(edges)[right] + 1e-9) + 1e-9)
    tau = f_r.mean() - f_l.mean()
    se  = np.sqrt(f_r.var()/len(f_r) + f_l.var()/len(f_l))
    return tau, se, tau / se

tau, se, t = mccrary_test(df["X"].values, cutoff=0)
print(f"McCrary jump = {tau:.3f} (SE {se:.3f}), t = {t:.2f}")
```

> 用于审稿正式报告时，建议通过 `rpy2` 调用 R `rddensity::rddensity` 以获取严谨实现。

## 5. 协变量平衡

```python
covars = ["age", "female", "edu"]
rows = []
for v in covars:
    r = rdrobust(df[v].values, df["X"].values, c=0, p=1, bwselect="mserd")
    rows.append({
        "var":   v,
        "tau":   r.coef.iloc[0, 0],
        "p_rb":  r.pv.iloc[2, 0],
        "h":     r.bws.iloc[0, 0],
    })
pd.DataFrame(rows)
```

## 6. 带宽稳健性扫描

```python
h0 = res.bws.iloc[0, 0]
mults = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0]
sweep = []
for m in mults:
    r = rdrobust(df["Y"].values, df["X"].values, c=0, p=1,
                 h = m * h0, kernel="triangular")
    sweep.append({
        "mult": m,
        "tau":  r.coef.iloc[0, 0],
        "se":   r.se.iloc[0, 0],
        "N":    int(r.N_h.sum()),
    })
sweep = pd.DataFrame(sweep)
print(sweep)

plt.figure()
plt.errorbar(sweep["mult"], sweep["tau"], yerr=1.96 * sweep["se"], fmt="o-")
plt.axhline(0, linestyle="--", color="gray")
plt.xlabel("h multiplier"); plt.ylabel("tau")
plt.title("Bandwidth sensitivity")
plt.show()
```

## 7. 多项式阶数

```python
for p in (1, 2, 3):
    r = rdrobust(df["Y"].values, df["X"].values, c=0, p=p, bwselect="mserd")
    print(f"p = {p}: tau = {r.coef.iloc[0,0]:.3f}, robust p = {r.pv.iloc[2,0]:.3f}")
```

## 8. Donut hole

```python
for eps in (0.02, 0.05, 0.10):
    keep = np.abs(df["X"].values) > eps
    r = rdrobust(df["Y"].values[keep], df["X"].values[keep],
                 c=0, p=1, bwselect="mserd")
    print(f"eps = {eps}: tau = {r.coef.iloc[0,0]:.3f}, "
          f"robust p = {r.pv.iloc[2,0]:.3f}")
```

## 输出解读 tips

- `rdrobust` 的 Python 端与 R/Stata API 95% 一致；输出的 `coef`/`ci`/`pv` 都是 3-行 DataFrame：Conventional / Bias-Corrected / Robust。
- 报告 **Robust 那行的 p 值与 CI**。
- `rdrobust` 不直接画图——`rdplot` 输出 matplotlib，可在主图基础上 `plt.savefig("fig/rdd_main.pdf")`。
- 当样本不大时：检查 `N_h` 字段；左右两侧合计 < 80 → 结果可信度低。
