"""heatmap_clustered.py - hierarchically clustered correlation heatmap."""
from __future__ import annotations

import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

try:
    from scipy.cluster.hierarchy import leaves_list, linkage
    HAS_SCIPY = True
except Exception:
    HAS_SCIPY = False

plt.rcParams.update({
    "font.family": "serif",
    "font.serif": ["Times New Roman", "SimSun", "Songti SC",
                   "Source Han Serif SC", "STSong"],
    "font.size": 9,
    "axes.unicode_minus": False,
    "axes.linewidth": 0.8,
})


def main() -> None:
    rng = np.random.default_rng(20260501)
    p = 12
    factors = [f"F{i+1}" for i in range(p)]
    base = rng.normal(size=(800, 4))
    blocks = [base[:, i % 4] + 0.4 * rng.normal(size=800) for i in range(p)]
    X = np.column_stack(blocks)
    corr = np.corrcoef(X.T)

    if HAS_SCIPY:
        order = leaves_list(linkage(corr, method="average"))
    else:
        order = np.arange(p)
    corr_o = corr[np.ix_(order, order)]
    labels_o = [factors[i] for i in order]

    fig, ax = plt.subplots(figsize=(4.0, 3.2))
    im = ax.imshow(corr_o, cmap="RdBu_r", vmin=-1, vmax=1)
    ax.set_xticks(range(p))
    ax.set_yticks(range(p))
    ax.set_xticklabels(labels_o, rotation=60, ha="right", fontsize=7)
    ax.set_yticklabels(labels_o, fontsize=7)
    cbar = fig.colorbar(im, ax=ax, fraction=0.045, pad=0.04)
    cbar.ax.tick_params(labelsize=7)
    cbar.set_label("correlation", fontsize=7)

    fig.savefig("heatmap_clustered.pdf", dpi=300, bbox_inches="tight",
                pad_inches=0.05)
    plt.close(fig)
    print("saved: heatmap_clustered.pdf", file=sys.stderr)


if __name__ == "__main__":
    main()
