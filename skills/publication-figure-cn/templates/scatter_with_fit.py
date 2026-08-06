"""散点 + 拟合线 —— 双变量关系，含 95% 置信带。

运行：python scatter_with_fit.py  → 生成 scatter_with_fit.pdf
"""
from __future__ import annotations
import os
import sys
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

plt.rcParams.update({
    "font.family": "serif",
    "font.serif": ["Times New Roman", "SimSun", "Songti SC",
                   "Source Han Serif SC", "STSong", "Noto Serif CJK SC"],
    "font.size": 9,
    "axes.unicode_minus": False,
    "axes.linewidth": 0.8,
    "xtick.direction": "in",
    "ytick.direction": "in",
    "legend.frameon": False,
})

# ---- 合成数据 ----
rng = np.random.default_rng(7)
n = 300
x = rng.normal(0, 1.0, n)
y = 0.45 * x + 0.5 + rng.normal(0, 0.7, n)

# OLS 拟合
beta, alpha = np.polyfit(x, y, 1)
x_grid = np.linspace(x.min(), x.max(), 100)
y_hat = alpha + beta * x_grid

# 95% CI（simple）
resid = y - (alpha + beta * x)
sigma = resid.std(ddof=2)
xmean = x.mean()
sxx = np.sum((x - xmean) ** 2)
se_pred = sigma * np.sqrt(1.0 / n + (x_grid - xmean) ** 2 / sxx)
ci_lo = y_hat - 1.96 * se_pred
ci_hi = y_hat + 1.96 * se_pred

# R²
ss_res = np.sum(resid ** 2)
ss_tot = np.sum((y - y.mean()) ** 2)
r2 = 1.0 - ss_res / ss_tot

# ---- 绘图 ----
fig, ax = plt.subplots(figsize=(3.3, 2.6))
ax.scatter(x, y, s=12, color="black", alpha=0.4, edgecolors="none")
ax.plot(x_grid, y_hat, color="black", linewidth=1.5)
ax.fill_between(x_grid, ci_lo, ci_hi, color="gray", alpha=0.25,
                edgecolor="none")

ax.set_xlabel("自变量 X（标准化）")
ax.set_ylabel("因变量 Y")
ax.text(0.04, 0.95,
        f"$\\beta = {beta:.3f}$\n$R^2 = {r2:.3f}$\n$N = {n}$",
        transform=ax.transAxes, fontsize=8, va="top",
        bbox=dict(boxstyle="round,pad=0.3", facecolor="white",
                  edgecolor="gray", linewidth=0.5))

out = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "scatter_with_fit.pdf")
fig.savefig(out, dpi=300, bbox_inches="tight", pad_inches=0.05)
plt.close(fig)
print(f"saved: {out}", file=sys.stderr)
