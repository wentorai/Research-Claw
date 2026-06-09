"""Synthetic 20-node co-authorship network -> GraphML for Gephi.
Computes degree + community, writes them into the .graphml.
Outputs: coauthor_network.graphml + coauthor_preview.png."""
from __future__ import annotations
import random
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import networkx as nx

plt.rcParams["font.sans-serif"] = ["SimSun", "Songti SC", "Source Han Serif SC", "Times New Roman", "DejaVu Sans"]
plt.rcParams["axes.unicode_minus"] = False

random.seed(42)


def build_synthetic() -> nx.Graph:
    """20 authors split into 3 labs, dense within lab, sparse between."""
    G = nx.Graph()
    labs = {"A": list(range(0, 7)), "B": list(range(7, 14)), "C": list(range(14, 20))}
    for lab, ids in labs.items():
        for i in ids:
            G.add_node(i, label=f"作者{i:02d}", lab=lab)
        # dense within lab
        for i in ids:
            for j in ids:
                if i < j and random.random() < 0.55:
                    G.add_edge(i, j, weight=random.randint(1, 5))
    # sparse cross-lab edges
    for _ in range(8):
        a, b = random.sample(list(G.nodes()), 2)
        if not G.has_edge(a, b):
            G.add_edge(a, b, weight=1)
    return G


def main() -> None:
    G = build_synthetic()
    deg = nx.degree_centrality(G)
    btw = nx.betweenness_centrality(G)
    nx.set_node_attributes(G, deg, "degree_centrality")
    nx.set_node_attributes(G, btw, "betweenness")
    try:
        comms = nx.community.greedy_modularity_communities(G)
        community_map = {n: i for i, c in enumerate(comms) for n in c}
    except Exception:
        community_map = {n: 0 for n in G.nodes()}
    nx.set_node_attributes(G, community_map, "community")

    nx.write_graphml(G, "coauthor_network.graphml")

    # Quick preview
    fig, ax = plt.subplots(figsize=(8, 6))
    pos = nx.spring_layout(G, seed=42, k=0.6)
    sizes = [400 + 4000 * deg[n] for n in G.nodes()]
    colors = [community_map[n] for n in G.nodes()]
    nx.draw_networkx_nodes(G, pos, node_size=sizes, node_color=colors,
                           cmap=plt.cm.Set2, edgecolors="#333333",
                           linewidths=0.8, ax=ax)
    weights = [G[u][v].get("weight", 1) for u, v in G.edges()]
    nx.draw_networkx_edges(G, pos, width=[w * 0.4 for w in weights],
                           edge_color="#999999", ax=ax)
    nx.draw_networkx_labels(G, pos, labels={n: G.nodes[n]["label"] for n in G.nodes()},
                            font_size=7, ax=ax)
    ax.set_axis_off()
    ax.set_title("合作网络预览 (Co-authorship preview)")
    plt.tight_layout()
    plt.savefig("coauthor_preview.png", dpi=200, bbox_inches="tight")
    plt.close(fig)
    print("Saved: coauthor_network.graphml, coauthor_preview.png")
    print(f"Nodes={G.number_of_nodes()}, Edges={G.number_of_edges()}, "
          f"Communities={len(set(community_map.values()))}")


if __name__ == "__main__":
    main()
