"""network_directors.py - interlocking-board company network."""
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
})


def main() -> None:
    rng = np.random.default_rng(20260501)
    n_co = 24
    adj = (rng.random((n_co, n_co)) < 0.12).astype(int)
    adj = np.triu(adj, 1)
    adj = adj + adj.T
    np.fill_diagonal(adj, 0)

    deg = adj.sum(axis=1)

    angles = np.linspace(0, 2 * np.pi, n_co, endpoint=False)
    xs = np.cos(angles)
    ys = np.sin(angles)

    fig, ax = plt.subplots(figsize=(4.0, 4.0))
    for i in range(n_co):
        for j in range(i + 1, n_co):
            if adj[i, j]:
                ax.plot([xs[i], xs[j]], [ys[i], ys[j]],
                        color="gray", linewidth=0.4, alpha=0.5,
                        zorder=1)
    sizes = 30 + (deg / max(deg.max(), 1)) * 200
    ax.scatter(xs, ys, s=sizes, c="black",
               edgecolors="white", linewidths=0.5, zorder=2)
    for i, (xi, yi) in enumerate(zip(xs, ys)):
        ax.text(xi * 1.10, yi * 1.10, f"C{i+1}",
                ha="center", va="center", fontsize=6)

    ax.set_xlim(-1.3, 1.3)
    ax.set_ylim(-1.3, 1.3)
    ax.set_aspect("equal")
    ax.axis("off")
    ax.text(0.02, 0.98,
            f"N={n_co} nodes, E={int(adj.sum() // 2)} edges, "
            f"avg degree={deg.mean():.1f}",
            transform=ax.transAxes, fontsize=7, va="top")

    fig.savefig("network_directors.pdf", dpi=300, bbox_inches="tight",
                pad_inches=0.05)
    plt.close(fig)
    print("saved: network_directors.pdf", file=sys.stderr)


if __name__ == "__main__":
    main()
