"""DAGitty-style causal DAG with NetworkX + matplotlib. Outputs PDF + PNG."""
from __future__ import annotations
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import networkx as nx

plt.rcParams["font.sans-serif"] = ["SimSun", "Songti SC", "Source Han Serif SC", "Times New Roman", "DejaVu Sans"]
plt.rcParams["axes.unicode_minus"] = False

ROLE_STYLE = {  # role -> (face, edge)
    "treatment": ("#fce4ec", "#c2185b"), "outcome": ("#e3f2fd", "#1565c0"),
    "confound":  ("#fff8e1", "#f57f17"), "mediator": ("#e8f5e9", "#2e7d32"),
    "instrument":("#f5f5f5", "#424242"), "latent":   ("#ffffff", "#9e9e9e"),
}
NODES = [  # (id, label, role, x, y)
    ("Z", "Z\n工具变量", "instrument", 0.05, 0.50),
    ("T", "T\n处理变量", "treatment",  0.30, 0.50),
    ("M", "M\n中介",     "mediator",   0.55, 0.65),
    ("Y", "Y\n结果变量", "outcome",    0.80, 0.50),
    ("W", "W\n混杂",     "confound",   0.55, 0.20),
    ("U", "U\n不可观测", "latent",     0.55, 0.85),
]
EDGES = [  # (src, dst, dashed)
    ("Z", "T", False), ("T", "M", False), ("M", "Y", False), ("T", "Y", False),
    ("W", "T", False), ("W", "Y", False), ("U", "T", True),  ("U", "Y", True),
]


def main() -> None:
    G = nx.DiGraph()
    pos, role_of, label_of = {}, {}, {}
    for nid, label, role, x, y in NODES:
        G.add_node(nid); pos[nid] = (x, y)
        role_of[nid] = role; label_of[nid] = label
    for s, d, _ in EDGES:
        G.add_edge(s, d)

    fig, ax = plt.subplots(figsize=(8, 5))
    for nid in G.nodes():
        face, edge = ROLE_STYLE[role_of[nid]]
        coll = nx.draw_networkx_nodes(G, pos, nodelist=[nid], node_color=face,
                                      edgecolors=edge, linewidths=2.0,
                                      node_size=2400, ax=ax)
        if role_of[nid] == "latent" and coll is not None:
            coll.set_linestyle("dashed")
    nx.draw_networkx_labels(G, pos, labels=label_of, font_size=10, ax=ax)
    solid  = [(s, d) for s, d, dash in EDGES if not dash]
    dashed = [(s, d) for s, d, dash in EDGES if dash]
    nx.draw_networkx_edges(G, pos, edgelist=solid, arrows=True, arrowsize=18,
                           edge_color="#333333", width=1.4,
                           connectionstyle="arc3,rad=0.05", ax=ax)
    nx.draw_networkx_edges(G, pos, edgelist=dashed, arrows=True, arrowsize=18,
                           edge_color="#9e9e9e", width=1.2, style="dashed",
                           connectionstyle="arc3,rad=0.05", ax=ax)
    ax.set_title("因果有向无环图 (Causal DAG, DAGitty-style)")
    ax.set_axis_off(); plt.tight_layout()
    plt.savefig("causal_dag.pdf", bbox_inches="tight")
    plt.savefig("causal_dag.png", dpi=300, bbox_inches="tight")
    plt.close(fig)
    print("Saved: causal_dag.pdf, causal_dag.png")


if __name__ == "__main__":
    main()
