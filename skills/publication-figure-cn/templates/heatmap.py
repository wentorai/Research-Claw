"""热图 —— 相关系数矩阵，发散色阶 + 单元格标注。

运行：python heatmap.py  → 生成 heatmap.pdf
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
})

# ---- 合成数据 ----
rng = np.random.default_rng(2024)
labels = ["资产规模", "杠杆率", "ROA", "ROE", "Tobin Q", "研发强度"]
n = len(labels)

# 构造一个对称、对角=1 的相关矩阵
A = rng.uniform(-0.6, 0.6, (n, n))
A = (A + A.T) / 2.0
np.fill_diagonal(A, 1.0)

# ---- 绘图 ----
fig, ax = plt.subplots(figsize=(3.5, 3.0))
im = ax.imshow(A, cmap="RdBu_r", vmin=-1, vmax=1, aspect="equal")

ax.set_xticks(np.arange(n))
ax.set_yticks(np.arange(n))
ax.set_xticklabels(labels, rotation=45, ha="right", fontsize=8)
ax.set_yticklabels(labels, fontsize=8)

# 单元格内显示数值
for i in range(n):
    for j in range(n):
        val = A[i, j]
        color = "white" if abs(val) > 0.5 else "black"
        ax.text(j, i, f"{val:.2f}", ha="center", va="center",
                fontsize=7, color=color)

# colorbar
cbar = fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04,
                    ticks=[-1, -0.5, 0, 0.5, 1])
cbar.set_label("相关系数", fontsize=8)
cbar.ax.tick_params(labelsize=7)

ax.set_title("变量相关系数矩阵", fontsize=10, pad=8)

out = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "heatmap.pdf")
fig.savefig(out, dpi=300, bbox_inches="tight", pad_inches=0.05)
plt.close(fig)
print(f"saved: {out}", file=sys.stderr)
