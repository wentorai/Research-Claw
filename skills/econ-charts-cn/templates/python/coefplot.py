"""coefplot.py - multi-regression coefficient plot."""
from __future__ import annotations

import os
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

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


def main() -> None:
    models = ["(1) baseline", "(2) +ctrl", "(3) +year FE", "(4) +year+ind FE"]
    terms = ["x1 (core)", "x2"]
    coef = np.array([[0.32, -0.18], [0.28, -0.15],
                     [0.30, -0.16], [0.27, -0.14]])
    se = np.array([[0.05, 0.05], [0.05, 0.05],
                   [0.04, 0.04], [0.04, 0.04]])
    ci = 1.96 * se

    fig, ax = plt.subplots(figsize=(3.5, 2.6))
    shapes = ["o", "s", "^", "D"]
    colors = ["#000000", "#404040", "#7F7F7F", "#A6A6A6"]
    y_offsets = np.linspace(-0.18, 0.18, len(models))

    for i, m in enumerate(models):
        y = np.arange(len(terms)) + y_offsets[i]
        ax.errorbar(coef[i], y, xerr=ci[i], fmt=shapes[i],
                    color=colors[i], ecolor=colors[i],
                    markersize=4.5, elinewidth=0.7, capsize=2,
                    label=m)

    ax.axvline(0, color="gray", linestyle="--", linewidth=0.5)
    ax.set_yticks(np.arange(len(terms)))
    ax.set_yticklabels(terms)
    ax.set_xlabel("regression coefficient (95% CI)")
    ax.invert_yaxis()
    ax.legend(loc="lower right", fontsize=7, ncol=2)

    fig.savefig("coefplot.pdf", dpi=300, bbox_inches="tight", pad_inches=0.05)
    plt.close(fig)
    print("saved: coefplot.pdf", file=sys.stderr)


if __name__ == "__main__":
    main()
