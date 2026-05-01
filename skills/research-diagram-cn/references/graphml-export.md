# GraphML / NetworkX / Gephi — 网络数据可视化路线

合作网络（co-authorship）、专利引用网络、供应链网络、文献共被引、社交网络……当节点数 > 50、边数 > 100 时，**Mermaid / TikZ 已无法表达**，必须走专业网络可视化工具。

## 1. 工具栈对比

| 工具 | 适用 | 优点 | 缺点 |
|------|------|------|------|
| **NetworkX** (Python) | 算法计算 + 简单画 | 标准 API、丰富算法（centrality、community、PageRank） | 大图绘图丑 |
| **igraph** (Python/R) | 大图算法 | 比 NetworkX 快 10×；R 端生态成熟 | 中文支持稍弱 |
| **Gephi** (GUI) | **手动调布局**、出版图 | 力导向布局极美，可交互；ForceAtlas2 经典 | GUI，无法批量 |
| **Cytoscape** | 生物 + 社会网络 | 插件多；适合分子网络 | 学习曲线陡 |
| **D3.js** | Web 交互 | 网页交互极佳 | 写 JS |

**推荐工作流**：
1. Python 用 NetworkX 算指标（degree, betweenness, modularity）
2. 导出 `.graphml` 或 `.gexf`
3. Gephi 打开 → 选 ForceAtlas2 / Yifan Hu 布局 → 调颜色 → Export PDF

## 2. GraphML 文件格式

GraphML 是 W3C 标准 XML 格式，几乎所有图工具都能读：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<graphml xmlns="http://graphml.graphdrawing.org/xmlns">
  <key id="d0" for="node" attr.name="label" attr.type="string"/>
  <key id="d1" for="node" attr.name="weight" attr.type="double"/>
  <key id="d2" for="edge" attr.name="weight" attr.type="double"/>
  <graph id="G" edgedefault="undirected">
    <node id="n1"><data key="d0">作者A</data></node>
    <node id="n2"><data key="d0">作者B</data></node>
    <edge source="n1" target="n2"><data key="d2">3.0</data></edge>
  </graph>
</graphml>
```

NetworkX 读写：

```python
import networkx as nx
G = nx.read_graphml("net.graphml")
nx.write_graphml(G, "out.graphml")
```

注意 GraphML 节点属性必须先在 `<key>` 里声明类型；NetworkX 会自动处理。

## 3. 何时用什么格式

| 格式 | 优点 | 用什么打开 |
|------|------|-----------|
| `.graphml` | 标准、属性多 | Gephi / Cytoscape / yEd / NetworkX |
| `.gexf` | Gephi 原生，支持时间动态 | Gephi |
| `.gml` | 轻量 | NetworkX / Gephi |
| `.edgelist` | 最简单（一行一边） | 任何工具 |
| `.csv` (nodes + edges) | Excel 可编辑 | Gephi（导入） |

**论文报告：用 GraphML**（最通用）。
**动态/演化网络：用 GEXF**（支持 `<spell start=... end=...>`）。

## 4. 出版图典型设置（Gephi 内）

| 参数 | 推荐值 |
|------|-------|
| 节点大小 | 度（degree）映射，min=2 max=20 |
| 节点颜色 | 社区检测（modularity）映射 |
| 标签字体 | Songti SC / SimSun（中文） / Times New Roman（英文）|
| 标签大小 | 度映射（大节点字才大） |
| 边粗细 | 边权重映射 |
| 边颜色 | 灰色（避免过饱） |
| 布局 | ForceAtlas2（推荐）/ Yifan Hu（小图）/ Fruchterman Reingold |
| 导出 DPI | 300+，PDF 矢量 |

## 5. NetworkX 常用算法

```python
import networkx as nx
G = nx.read_graphml("net.graphml")

# 度中心性
deg = nx.degree_centrality(G)
# 介数中心性（计算慢，大图谨慎）
btw = nx.betweenness_centrality(G, k=100)
# PageRank
pr = nx.pagerank(G)
# 社区检测（Louvain，需 python-louvain 包）
import community as community_louvain
partition = community_louvain.best_partition(G)
```

## 6. 把指标写回 GraphML

```python
nx.set_node_attributes(G, deg, "degree_centrality")
nx.set_node_attributes(G, partition, "community")
nx.write_graphml(G, "net_with_metrics.graphml")
```

Gephi 打开后这些属性可直接在 Appearance 面板做映射。

## 7. 常见坑

1. **属性丢失**：CSV 导出再导入容易丢属性，**优先 GraphML / GEXF**。
2. **中文标签**：Gephi 默认字体不含中文，需在 Preview → Font 切换到 Songti SC。
3. **巨型图（> 10 万节点）**：NetworkX 卡，换 graph-tool 或 igraph；Gephi 选择 OpenORD 布局。
4. **有向 vs 无向**：合作 = undirected；引用 = directed；GraphML 用 `edgedefault="directed"` 指定。
5. **多重边（同一对节点多条边）**：GraphML 支持（`parse.edgeids="true"`），但 NetworkX 默认不保留；用 `nx.MultiGraph()`。

## 8. 模板

`templates/python/graphml_export.py`：合成一个 20-节点合作网络 → 计算 degree / community → 写出 `.graphml`，可直接拖到 Gephi 调布局。
