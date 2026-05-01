"""柱状图（带误差棒）—— 分组对比，hatch 填充黑白可读。

运行：python bar_chart.py  → 生成 bar_chart.pdf
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
groups = ["国有企业", "民营企业", "外资企业", "集体企业"]
mean_pre = np.array([3.2, 4.5, 5.1, 2.8])
mean_post = np.array([3.5, 6.2, 5.4, 3.0])
se_pre = np.array([0.20, 0.25, 0.30, 0.18])
se_post = np.array([0.22, 0.28, 0.32, 0.20])

x = np.arange(len(groups))
width = 0.38

# ---- 绘图 ----
fig, ax = plt.subplots(figsize=(3.5, 2.5))

b1 = ax.bar(x - width / 2, mean_pre, width,
            color="white", edgecolor="black", hatch="",
            linewidth=0.8, label="政策前")
b2 = ax.bar(x + width / 2, mean_post, width,
            color="#999999", edgecolor="black", hatch="///",
            linewidth=0.8, label="政策后")

ax.errorbar(x - width / 2, mean_pre, yerr=se_pre, fmt="none",
            ecolor="black", capsize=3, elinewidth=0.8)
ax.errorbar(x + width / 2, mean_post, yerr=se_post, fmt="none",
            ecolor="black", capsize=3, elinewidth=0.8)

ax.set_xticks(x)
ax.set_xticklabels(groups, fontsize=8)
ax.set_ylabel("研发投入强度（%）")
ax.set_ylim(0, max(mean_post.max(), mean_pre.max()) * 1.25)
ax.legend(loc="upper left")

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bar_chart.pdf")
fig.savefig(out, dpi=300, bbox_inches="tight", pad_inches=0.05)
plt.close(fig)
print(f"saved: {out}", file=sys.stderr)
