"""event_study.py - DiD event-study dynamic effect plot.

Run: python event_study.py  ->  event_study.pdf
"""
from __future__ import annotations

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
    rng = np.random.default_rng(20260501)
    periods = np.arange(-4, 6)
    coef = np.array([-0.02, 0.01, 0.00, 0.00,
                     0.05, 0.12, 0.18, 0.22, 0.20, 0.17])
    se = np.array([0.05, 0.05, 0.04, 0.00,
                   0.04, 0.05, 0.06, 0.07, 0.07, 0.07])
    base_idx = int(np.where(periods == -1)[0][0])

    fig, ax = plt.subplots(figsize=(3.5, 2.6))
    ax.errorbar(periods, coef, yerr=1.96 * se,
                fmt="o", color="black", ecolor="black",
                capsize=3, elinewidth=0.8, markersize=5,
                markerfacecolor="black")
    ax.plot(periods[base_idx], coef[base_idx], "o",
            markerfacecolor="white", markeredgecolor="black",
            markersize=6, zorder=5)

    ax.axhline(0, color="gray", linestyle="--", linewidth=0.6)
    ax.axvline(-0.5, color="gray", linestyle=":", linewidth=0.6)
    ax.set_xlabel("years since policy implementation")
    ax.set_ylabel("treatment effect (95% CI)")
    ax.set_xticks(periods)

    fig.savefig("event_study.pdf", dpi=300, bbox_inches="tight",
                pad_inches=0.05)
    plt.close(fig)
    _ = rng  # keep rng import lint-quiet
    print("saved: event_study.pdf", file=sys.stderr)


if __name__ == "__main__":
    main()
