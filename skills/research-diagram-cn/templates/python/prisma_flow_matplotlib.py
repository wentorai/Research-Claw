"""PRISMA 2020 flow diagram, pure matplotlib (no graphviz). Outputs PDF + PNG."""
from __future__ import annotations
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch

plt.rcParams["font.sans-serif"] = ["SimSun", "Songti SC", "Source Han Serif SC", "Times New Roman", "DejaVu Sans"]
plt.rcParams["axes.unicode_minus"] = False

PHASE_FACE = {"ident": "#cfe8fc", "screen": "#fff3c4", "elig": "#ffd9b3",
              "incl":  "#c8e6c9", "excl":   "#ffcdd2"}
PHASE_EDGE = {"ident": "#1565c0", "screen": "#f9a825", "elig": "#ef6c00",
              "incl":  "#2e7d32", "excl":   "#c62828"}

# (xc, yc, w, h, text, phase)
BOXES = [
    (0.30, 0.92, 0.55, 0.10, "Identification 识别\nPubMed n=1234, WoS n=987,\nScopus n=654, CNKI n=321\nTotal n = 3196", "ident"),
    (0.30, 0.76, 0.55, 0.08, "Records after duplicates removed\n去重后 n = 2510", "ident"),
    (0.30, 0.60, 0.55, 0.08, "Records screened (title/abstract)\n标题/摘要筛选 n = 2510", "screen"),
    (0.85, 0.60, 0.28, 0.08, "Excluded 排除\nn = 2150", "excl"),
    (0.30, 0.44, 0.55, 0.08, "Reports assessed for eligibility\n全文复核 n = 360", "elig"),
    (0.85, 0.44, 0.28, 0.18, "Excluded with reasons:\n  人群不符 n=80\n  干预不符 n=70\n  结果不符 n=60\n  设计不符 n=50\n  重复发表 n=20\n  全文不可得 n=10", "excl"),
    (0.30, 0.24, 0.55, 0.08, "Included in qualitative synthesis\n纳入定性综述 n = 70", "incl"),
    (0.30, 0.10, 0.55, 0.08, "Included in meta-analysis\n纳入 meta-analysis n = 45", "incl"),
]
ARROWS = [(0, 1), (1, 2), (2, 3), (2, 4), (4, 5), (4, 6), (6, 7)]


def main() -> None:
    fig, ax = plt.subplots(figsize=(10, 11))
    ax.set_xlim(0, 1.2); ax.set_ylim(0, 1.0)
    ax.set_aspect("equal"); ax.set_axis_off()
    for xc, yc, w, h, text, phase in BOXES:
        ax.add_patch(FancyBboxPatch(
            (xc - w/2, yc - h/2), w, h,
            boxstyle="round,pad=0.01,rounding_size=0.012",
            facecolor=PHASE_FACE[phase], edgecolor=PHASE_EDGE[phase], linewidth=1.6))
        ax.text(xc, yc, text, ha="center", va="center", fontsize=8.5)
    for f, t in ARROWS:
        fb, tb = BOXES[f], BOXES[t]
        if abs(fb[0] - tb[0]) > 0.1:  # side branch
            x0, y0 = fb[0] + fb[2]/2, fb[1]
            x1, y1 = tb[0] - tb[2]/2, tb[1]
        else:
            x0, y0 = fb[0], fb[1] - fb[3]/2
            x1, y1 = tb[0], tb[1] + tb[3]/2
        ax.add_patch(FancyArrowPatch((x0, y0), (x1, y1), arrowstyle="->",
                                     mutation_scale=15, color="#333333", linewidth=1.2))
    ax.set_title("PRISMA 2020 Flow Diagram", fontsize=13, pad=15)
    plt.tight_layout()
    plt.savefig("prisma_flow.pdf", bbox_inches="tight")
    plt.savefig("prisma_flow.png", dpi=300, bbox_inches="tight")
    plt.close(fig)
    print("Saved: prisma_flow.pdf, prisma_flow.png")


if __name__ == "__main__":
    main()
