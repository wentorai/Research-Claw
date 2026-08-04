"""sankey.py - simple capital-flow Sankey using matplotlib only."""
from __future__ import annotations

import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.patches as mpatches
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
    src_labels = ["Bank A", "Bank B", "Bank C", "Bank D"]
    dst_labels = ["Firm 1", "Firm 2", "Firm 3", "Firm 4", "Firm 5"]
    rng = np.random.default_rng(20260501)
    flow = rng.uniform(1, 10, size=(len(src_labels), len(dst_labels)))

    src_total = flow.sum(axis=1)
    dst_total = flow.sum(axis=0)
    total = flow.sum()

    fig, ax = plt.subplots(figsize=(4.5, 3.5))

    src_y = 0
    src_pos = {}
    for i, lbl in enumerate(src_labels):
        h = src_total[i] / total
        ax.add_patch(mpatches.Rectangle((0, src_y), 0.04, h,
                                         facecolor="black"))
        ax.text(-0.01, src_y + h / 2, lbl,
                ha="right", va="center", fontsize=7)
        src_pos[i] = (src_y, src_y + h)
        src_y += h + 0.01

    dst_y = 0
    dst_pos = {}
    for j, lbl in enumerate(dst_labels):
        h = dst_total[j] / total
        ax.add_patch(mpatches.Rectangle((1.0, dst_y), 0.04, h,
                                         facecolor="black"))
        ax.text(1.06, dst_y + h / 2, lbl,
                ha="left", va="center", fontsize=7)
        dst_pos[j] = (dst_y, dst_y + h)
        dst_y += h + 0.01

    src_cursor = {i: src_pos[i][0] for i in range(len(src_labels))}
    dst_cursor = {j: dst_pos[j][0] for j in range(len(dst_labels))}
    grays = np.linspace(0.3, 0.85, len(src_labels))
    for i in range(len(src_labels)):
        for j in range(len(dst_labels)):
            h = flow[i, j] / total
            y0a = src_cursor[i]; y0b = src_cursor[i] + h
            y1a = dst_cursor[j]; y1b = dst_cursor[j] + h
            xs = np.linspace(0.04, 1.0, 50)
            t = (xs - 0.04) / (1.0 - 0.04)
            ya_curve = y0a + (y1a - y0a) * (3 * t**2 - 2 * t**3)
            yb_curve = y0b + (y1b - y0b) * (3 * t**2 - 2 * t**3)
            ax.fill_between(xs, ya_curve, yb_curve,
                             color=str(grays[i]), alpha=0.55, linewidth=0)
            src_cursor[i] += h
            dst_cursor[j] += h

    ax.set_xlim(-0.25, 1.30)
    ax.set_ylim(-0.02, max(src_y, dst_y) + 0.02)
    ax.axis("off")

    fig.savefig("sankey.pdf", dpi=300, bbox_inches="tight", pad_inches=0.05)
    plt.close(fig)
    print("saved: sankey.pdf", file=sys.stderr)


if __name__ == "__main__":
    main()
