"""箱线图 —— 多组分布对比，黑白可读 + 均值点叠加。

运行：python box_plot.py  → 生成 box_plot.pdf
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
rng = np.random.default_rng(11)
groups = ["制造业", "服务业", "金融业", "信息技术"]
data = [
    rng.normal(0.05, 0.04, 200),
    rng.normal(0.08, 0.05, 220),
    rng.normal(0.11, 0.06, 180),
    rng.normal(0.13, 0.07, 160),
]

# ---- 绘图 ----
fig, ax = plt.subplots(figsize=(3.5, 2.6))

bp = ax.boxplot(
    data, labels=groups, widths=0.55, patch_artist=True,
    boxprops=dict(facecolor="white", edgecolor="black", linewidth=0.8),
    whiskerprops=dict(color="black", linewidth=0.8),
    capprops=dict(color="black", linewidth=0.8),
    medianprops=dict(color="black", linewidth=1.4),
    flierprops=dict(marker="o", markersize=3, markerfacecolor="none",
                    markeredgecolor="gray", linestyle="none"),
)

# 叠加均值点
means = [d.mean() for d in data]
ax.plot(np.arange(1, len(groups) + 1), means,
        marker="D", linestyle="none", markersize=5,
        markerfacecolor="black", markeredgecolor="black",
        label="均值")

ax.set_ylabel("ROA（净资产收益率）")
ax.legend(loc="upper left")

# 样本量
for i, d in enumerate(data, start=1):
    ax.text(i, ax.get_ylim()[0] * 0.95 + ax.get_ylim()[1] * 0.05,
            f"N={len(d)}", ha="center", fontsize=7)

out = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "box_plot.pdf")
fig.savefig(out, dpi=300, bbox_inches="tight", pad_inches=0.05)
plt.close(fig)
print(f"saved: {out}", file=sys.stderr)
