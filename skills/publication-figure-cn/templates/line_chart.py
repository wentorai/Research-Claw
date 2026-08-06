"""折线图标准模板 —— 多组对比，黑白可读。

运行：python line_chart.py  → 生成 line_chart.pdf
"""
from __future__ import annotations
import os
import sys
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

# ---- 中文期刊默认设置 ----
plt.rcParams.update({
    "font.family": "serif",
    "font.serif": ["Times New Roman", "SimSun", "Songti SC",
                   "Source Han Serif SC", "STSong", "Noto Serif CJK SC"],
    "font.size": 9,
    "axes.unicode_minus": False,
    "axes.linewidth": 0.8,
    "xtick.direction": "in",
    "ytick.direction": "in",
    "lines.linewidth": 1.5,
    "lines.markersize": 5,
    "legend.frameon": False,
})

# ---- 合成数据 ----
rng = np.random.default_rng(42)
years = np.arange(2010, 2024)
treat = 100 + np.cumsum(rng.normal(2.5, 1.2, len(years)))
control = 100 + np.cumsum(rng.normal(1.5, 1.0, len(years)))
benchmark = 100 + np.cumsum(rng.normal(1.0, 0.8, len(years)))

# ---- 绘图 ----
fig, ax = plt.subplots(figsize=(3.3, 2.5))

ax.plot(years, treat, color="black", linestyle="-", marker="o",
        label="处理组")
ax.plot(years, control, color="#666666", linestyle="--", marker="s",
        label="对照组")
ax.plot(years, benchmark, color="#999999", linestyle="-.", marker="^",
        label="基准组")

ax.set_xlabel("年份")
ax.set_ylabel("指数（2010=100）")
ax.set_xticks(years[::2])
ax.legend(loc="upper left")

# 政策时点标注
ax.axvline(2017, color="black", linestyle=":", linewidth=0.8, alpha=0.7)
ax.text(2017.1, ax.get_ylim()[1] * 0.97, "政策冲击", fontsize=7,
        va="top", ha="left")

# ---- 导出 ----
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "line_chart.pdf")
fig.savefig(out, dpi=300, bbox_inches="tight", pad_inches=0.05)
plt.close(fig)
print(f"saved: {out}", file=sys.stderr)
