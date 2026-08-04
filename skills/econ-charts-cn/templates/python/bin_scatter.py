"""bin_scatter.py - large-sample bin scatter (self-implemented)."""
from __future__ import annotations

import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

plt.rcParams.update({
    "font.family": "serif",
    "font.serif": ["Times New Roman", "SimSun", "Songti SC",
                   "Source Han Serif SC", "STSong"],
    "font.size": 9,
    "axes.unicode_minus": False,
    "axes.linewidth": 0.8,
    "xtick.direction": "in",
    "ytick.direction": "in",
    "legend.frameon": False,
})


def main() -> None:
    rng = np.random.default_rng(20260501)
    n = 20000
    x = rng.normal(0, 1.5, n)
    ctrl = rng.normal(size=n)
    y = 0.4 * x + 0.15 * x**2 + 0.20 * ctrl + rng.normal(0, 1.2, n)

    n_bins = 25
    edges = np.quantile(x, np.linspace(0, 1, n_bins + 1))
    edges[0] -= 1e-6
    bin_idx = np.digitize(x, edges) - 1
    bin_idx = np.clip(bin_idx, 0, n_bins - 1)
    bx = np.array([x[bin_idx == k].mean() for k in range(n_bins)])
    by = np.array([y[bin_idx == k].mean() for k in range(n_bins)])

    coef = np.polyfit(x, y, 2)
    xx = np.linspace(x.min(), x.max(), 200)
    yy = np.polyval(coef, xx)

    fig, ax = plt.subplots(figsize=(3.5, 2.6))
    ax.plot(xx, yy, color="black", linewidth=0.8, label="quadratic fit")
    ax.scatter(bx, by, color="black", s=18, marker="o",
               label=f"binned mean (n_bins={n_bins})")
    ax.set_xlabel("X (standardized)")
    ax.set_ylabel("Y")
    ax.legend(fontsize=7, loc="best")

    fig.savefig("bin_scatter.pdf", dpi=300, bbox_inches="tight",
                pad_inches=0.05)
    plt.close(fig)
    print("saved: bin_scatter.pdf", file=sys.stderr)


if __name__ == "__main__":
    main()
