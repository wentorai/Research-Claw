"""系数图（DiD 事件研究 / IV）—— 动态系数 + 95% CI。

运行：python coefficient_plot.py  → 生成 coefficient_plot.pdf
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

# ---- 合成事件研究系数 ----
periods = np.arange(-4, 6)               # -4, -3, ..., 5
coef = np.array([-0.02, 0.01, 0.00, 0.0,
                 0.05, 0.12, 0.18, 0.22, 0.20, 0.17])
se = np.array([0.05, 0.05, 0.04, 0.0,
               0.04, 0.05, 0.06, 0.07, 0.07, 0.07])
ci_lo = coef - 1.96 * se
ci_hi = coef + 1.96 * se

# t = -1 基期：matplotlib 中用空心圆表示 normalized to 0
base_idx = np.where(periods == -1)[0][0]

# ---- 绘图 ----
fig, ax = plt.subplots(figsize=(3.5, 2.6))

# 误差棒
ax.errorbar(periods, coef, yerr=1.96 * se,
            fmt="o", color="black", ecolor="black",
            capsize=3, elinewidth=0.8, markersize=5,
            markerfacecolor="black")

# 基期空心
ax.plot(periods[base_idx], coef[base_idx], "o",
        markerfacecolor="white", markeredgecolor="black",
        markersize=6, zorder=5)

# 0 参考线、政策时点
ax.axhline(0, color="gray", linestyle="--", linewidth=0.6)
ax.axvline(-0.5, color="gray", linestyle=":", linewidth=0.6)

ax.set_xlabel("距政策实施年份（年）")
ax.set_ylabel("处理效应估计")
ax.set_xticks(periods)
ax.text(0.02, 0.97, "(a) 基准结果", transform=ax.transAxes,
        fontsize=9, fontweight="bold", va="top")

out = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "coefficient_plot.pdf")
fig.savefig(out, dpi=300, bbox_inches="tight", pad_inches=0.05)
plt.close(fig)
print(f"saved: {out}", file=sys.stderr)
