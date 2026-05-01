"""Hypothesis relationship tree (H1, H2 + H1a/H1b sub-hypotheses).

Output: hypothesis_tree.pdf + hypothesis_tree.png.
Run:   python3 hypothesis_tree.py
"""
from __future__ import annotations
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import networkx as nx

plt.rcParams["font.sans-serif"] = ["SimSun", "Songti SC", "Source Han Serif SC", "Times New Roman", "DejaVu Sans"]
plt.rcParams["axes.unicode_minus"] = False

# (id, label, layer, x_pct)
NODES = [
    ("RQ", "研究问题:\n数字化转型如何影响企业绩效?", 0, 0.50),
    ("H1", "H1: 数字化转型 → 企业绩效\n(主效应, +)", 1, 0.20),
    ("H2", "H2: 通过创新中介\n(中介, +)", 1, 0.50),
    ("H3", "H3: 行业竞争调节\n(调节)", 1, 0.80),
    ("H1a", "H1a: 长期绩效 (+)", 2, 0.10),
    ("H1b", "H1b: 短期绩效 (~)", 2, 0.30),
    ("H2a", "H2a: → 创新投入 (+)", 2, 0.42),
    ("H2b", "H2b: 创新 → 绩效 (+)", 2, 0.58),
    ("H3a", "H3a: 强化主效应", 2, 0.72),
    ("H3b", "H3b: 强化中介", 2, 0.88),
]

# (parent, child)
EDGES = [
    ("RQ", "H1"), ("RQ", "H2"), ("RQ", "H3"),
    ("H1", "H1a"), ("H1", "H1b"),
    ("H2", "H2a"), ("H2", "H2b"),
    ("H3", "H3a"), ("H3", "H3b"),
]

LAYER_Y = {0: 0.90, 1: 0.55, 2: 0.18}
LAYER_COLOR = {
    0: ("#fff8e1", "#f57f17"),
    1: ("#cfe8fc", "#1565c0"),
    2: ("#c8e6c9", "#2e7d32"),
}


def main() -> None:
    G = nx.DiGraph()
    pos: dict[str, tuple[float, float]] = {}
    layer_of: dict[str, int] = {}
    label_of: dict[str, str] = {}
    for nid, label, layer, x in NODES:
        G.add_node(nid)
        pos[nid] = (x, LAYER_Y[layer])
        layer_of[nid] = layer
        label_of[nid] = label
    G.add_edges_from(EDGES)

    fig, ax = plt.subplots(figsize=(11, 6))
    for nid in G.nodes():
        face, edge = LAYER_COLOR[layer_of[nid]]
        size = 4500 if layer_of[nid] == 0 else (3000 if layer_of[nid] == 1 else 2200)
        nx.draw_networkx_nodes(G, pos, nodelist=[nid], node_color=face,
                               edgecolors=edge, linewidths=1.6,
                               node_size=size, node_shape="s", ax=ax)
    nx.draw_networkx_labels(G, pos, labels=label_of, font_size=8, ax=ax)
    nx.draw_networkx_edges(G, pos, edge_color="#555555", arrows=True,
                           arrowsize=14, width=1.2,
                           connectionstyle="arc3,rad=0.0", ax=ax)
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.set_axis_off()
    ax.set_title("假设关系树 Hypothesis Tree", fontsize=13)
    plt.tight_layout()
    plt.savefig("hypothesis_tree.pdf", bbox_inches="tight")
    plt.savefig("hypothesis_tree.png", dpi=300, bbox_inches="tight")
    plt.close(fig)
    print("Saved: hypothesis_tree.pdf, hypothesis_tree.png")


if __name__ == "__main__":
    main()
