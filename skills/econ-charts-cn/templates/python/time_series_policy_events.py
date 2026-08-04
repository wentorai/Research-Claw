"""time_series_policy_events.py - macro time series w/ policy event vlines."""
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
})


def main() -> None:
    rng = np.random.default_rng(20260501)
    years = np.arange(2005, 2025)
    base = 100.0
    drift = np.cumsum(rng.normal(0.5, 1.5, size=len(years)))
    series = base + drift

    events = {
        2008: "GFC",
        2013: "Reform",
        2017: "Pilot",
        2020: "Covid",
    }

    fig, ax = plt.subplots(figsize=(4.5, 2.6))
    ax.plot(years, series, color="black", linewidth=1.0,
            marker="o", markersize=3)

    y_top = series.max() * 1.005
    for yr, name in events.items():
        ax.axvline(yr, color="gray", linestyle=":", linewidth=0.6)
        ax.text(yr + 0.1, y_top, name,
                fontsize=7, color="gray", rotation=90,
                ha="left", va="top")

    ax.set_xlabel("year")
    ax.set_ylabel("variable (level)")
    ax.set_xticks(years[::2])

    fig.savefig("time_series_policy_events.pdf",
                dpi=300, bbox_inches="tight", pad_inches=0.05)
    plt.close(fig)
    print("saved: time_series_policy_events.pdf", file=sys.stderr)


if __name__ == "__main__":
    main()
