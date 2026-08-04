#!/usr/bin/env Rscript
# network_boards.R: replace toy data with your analysis output.
# network_boards.R —— 董事兼任公司网络图 (igraph + ggraph)
# install.packages(c("igraph", "ggraph", "ggplot2", "tidygraph"))
# 运行: Rscript network_boards.R   ->  network_boards_out.pdf
# ----------------------------------------------------------------
# 用途: 30 家公司 + 80 名独立董事, 构建二部图后投影到公司层,
#       节点大小 = degree centrality, 节点颜色 = Louvain 社区.
# ----------------------------------------------------------------

suppressPackageStartupMessages({
  library(igraph)
  library(ggraph)
  library(ggplot2)
  library(tidygraph)
})

set.seed(20260501)

# ---- 1. 合成"公司-董事"二部图 ----
n_co <- 30
n_dr <- 80

edges <- data.frame(
  director = sample(1:n_dr, 200, replace = TRUE),
  company  = sample(1:n_co, 200, replace = TRUE)
)
edges <- unique(edges)

# 二部 → 投影到公司层 (两公司若共享 1+ 董事则连边)
co_edges <- merge(edges, edges, by = "director")
co_edges <- subset(co_edges, company.x < company.y)
co_edges <- aggregate(director ~ company.x + company.y, data = co_edges,
                      FUN = length)
names(co_edges) <- c("from", "to", "weight")

g <- graph_from_data_frame(co_edges, directed = FALSE,
                           vertices = data.frame(name = as.character(1:n_co)))

# ---- 2. 度中心性 + Louvain 社区 ----
V(g)$deg <- degree(g)
comm     <- cluster_louvain(g)
V(g)$community <- as.factor(membership(comm))

cat("Network: nodes =", vcount(g),
    ", edges =", ecount(g),
    ", avg degree =", round(mean(degree(g)), 2),
    ", clustering =", round(transitivity(g, type = "global"), 3), "\n")

# ---- 3. ggraph 绘图 ----
p <- ggraph(g, layout = "fr") +
  geom_edge_link(aes(width = weight),
                 color = "gray70", alpha = 0.5) +
  geom_node_point(aes(size = deg, fill = community),
                  shape = 21, color = "black", stroke = 0.3) +
  geom_node_text(aes(label = name), size = 2,
                 repel = TRUE, max.overlaps = 50) +
  scale_edge_width(range = c(0.2, 1.5), guide = "none") +
  scale_size_continuous(range = c(2, 7), name = "度中心性") +
  scale_fill_grey(start = 0.2, end = 0.95, name = "社区") +
  labs(caption = "注: 节点 = 公司; 边 = 共享 1+ 独董; 节点大小 = degree, 颜色 = Louvain 社区.") +
  theme_void(base_size = 9) +
  theme(legend.position = "bottom",
        legend.text = element_text(size = 7),
        plot.caption = element_text(size = 7, hjust = 0))

ggsave("network_boards_out.pdf", p, width = 12, height = 9,
       units = "cm", device = cairo_pdf)
message("saved: network_boards_out.pdf")
