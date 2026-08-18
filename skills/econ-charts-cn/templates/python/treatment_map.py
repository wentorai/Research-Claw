"""treatment_map.py - China province treatment map (synthetic grid)."""
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
    provinces = ["BJ", "TJ", "HE", "SX", "NM", "LN", "JL",
                 "HL", "SH", "JS", "ZJ", "AH", "FJ", "JX",
                 "SD", "HA", "HB", "HN", "GD", "GX", "HI",
                 "CQ", "SC", "GZ", "YN", "XZ", "SN", "GS",
                 "QH", "NX", "XJ"]
    n_p = len(provinces)
    rng = np.random.default_rng(20260501)
    treat = (rng.random(n_p) < 0.35).astype(int)

    cols = 7
    fig, ax = plt.subplots(figsize=(4.5, 3.2))
    for i, prov in enumerate(provinces):
        x = i % cols
        y = i // cols
        face = "#08306B" if treat[i] else "white"
        text_color = "white" if treat[i] else "black"
        ax.add_patch(mpatches.Rectangle((x, -y), 1, 1,
                                         facecolor=face,
                                         edgecolor="black",
                                         linewidth=0.5))
        ax.text(x + 0.5, -y + 0.5, prov,
                ha="center", va="center", fontsize=6, color=text_color)

    ax.set_xlim(-0.2, cols + 0.2)
    ax.set_ylim(-(n_p // cols) - 0.5, 1.2)
    ax.set_aspect("equal")
    ax.axis("off")

    legend_handles = [
        mpatches.Patch(facecolor="#08306B", edgecolor="black",
                       label="treated (pilot)"),
        mpatches.Patch(facecolor="white", edgecolor="black",
                       label="control"),
    ]
    ax.legend(handles=legend_handles, loc="lower center", ncol=2,
              fontsize=7, bbox_to_anchor=(0.5, -0.05),
              frameon=False)

    fig.savefig("treatment_map.pdf", dpi=300, bbox_inches="tight",
                pad_inches=0.05)
    plt.close(fig)
    print("saved: treatment_map.pdf", file=sys.stderr)


if __name__ == "__main__":
    main()
