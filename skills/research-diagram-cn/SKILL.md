---
name: research-diagram-cn
description: 研究流程图 / 因果 DAG / PRISMA 流程图 / 假设关系图 / 网络图（GraphML）自动生成 Skill。提供 Mermaid 语法速查 + Python (networkx/matplotlib) + LaTeX TikZ 三条路线的模板。覆盖 5 类常用研究图：研究流程、理论框架、PRISMA 系统综述、DiD 实验设计、合作/引用网络。当用户绘制论文流程图、设计因果识别策略可视化、或导出 Gephi/Cytoscape 兼容文件时调用本 Skill。
tags: [diagram, mermaid, dag, prisma, networkx, graphml, latex, tikz, visualization]
version: 0.1.0
author: HaonanAlex
license: Apache-2.0
---

# research-diagram-cn — 研究图自动生成（Mermaid / NetworkX / TikZ）

科研论文中**研究流程图、因果 DAG、PRISMA 流程图、假设关系树、合作/引用网络**是高频可视化需求，但传统工具门槛较高（dot/graphviz/dagitty/gephi）。本 Skill 教 AI agent 用三条互补路线一站式产出：

| 路线 | 适用场景 | 优点 |
|------|----------|------|
| **Mermaid** | Markdown / Notion / Obsidian / GitHub README | 文本即图，所见即所得，最易展示与版本管理 |
| **Python (networkx + matplotlib)** | 论文 PNG/PDF 插图、批量自动化 | 免装 graphviz，纯 Python，可程序化 |
| **LaTeX TikZ** | 投稿到 AER/JF/Nature/IEEE 的高分辨率图 | 矢量、与正文字体一致 |

## What it does

- 5 类常用研究图模板，开箱即用：研究流程、理论框架、PRISMA、DiD 设计、网络图
- 中文标签 fully supported（Mermaid 直接写中文；matplotlib 用 SimSun/Songti SC fallback）
- 三条路线互补：先用 Mermaid 草图→定稿改 Python/TikZ
- 导出 GraphML 与 Gephi/Cytoscape 互通，处理大型合作网络/专利引用网络

## Diagram types covered

| 图类型 | 用途 | Mermaid 模板 | Python 模板 | TikZ 模板 |
|--------|------|---------------|-------------|-----------|
| 研究流程图 | 选题→投稿全流程 | `research-workflow.mmd` | — | — |
| 理论框架 | 调节/中介关系 | `theoretical-framework.mmd` | — | — |
| PRISMA 2020 | 系统综述筛选流程 | `prisma-flow.mmd` | `prisma_flow_matplotlib.py` | — |
| DiD 实验设计 | 处理/对照、Pre/Post | `did-design.mmd` | — | — |
| 实证流水线 | 数据→清洗→回归→稳健 | `empirical-pipeline.mmd` | — | — |
| 因果 DAG | 处理/混杂/工具/中介 | — | `causal_dag_dagitty.py` | `causal_dag.tex` |
| 假设关系树 | H1/H2 + 子假设 | — | `hypothesis_tree.py` | — |
| 合作/引用网络 | Gephi 互通 | — | `graphml_export.py` | — |

## Trigger phrases

中文：研究流程图、因果图、DAG、混杂变量、PRISMA、系统综述、假设关系、理论框架、调节中介图、合作网络、引用网络、Mermaid、TikZ、Gephi、GraphML。

English: research workflow diagram, causal DAG, confounder, PRISMA flow, hypothesis tree, theoretical framework, mediation moderation, co-authorship network, citation network, Mermaid, TikZ, GraphML, NetworkX.

## How to use this Skill

1. **判断展示载体**：
   - Markdown / GitHub / Notion → 用 `templates/mermaid/*.mmd`
   - 论文 PDF 插图 → 用 `templates/python/*.py` 生成 PNG/PDF
   - LaTeX 投稿 → 用 `templates/tikz/causal_dag.tex`
2. **挑模板**：参考上表，复制对应文件并替换变量名 / 中文标签。
3. **读规范**：
   - 因果图先读 `references/causal-dag-rules.md`（DAGitty 视觉约定）
   - PRISMA 严格遵循 `references/prisma-2020.md`（识别/筛选/纳入 4 阶段）
   - 假设树参照 `references/hypothesis-tree.md`
4. **导出 Gephi**：网络数据走 `templates/python/graphml_export.py`，Gephi 打开 .graphml 调布局。

## File map

```
SKILL.md                              (this file)
references/
  mermaid-cheatsheet.md               Mermaid 全语法速查（含中文）
  causal-dag-rules.md                 DAGitty 因果图视觉规范
  prisma-2020.md                      PRISMA 2020 流程图规范
  hypothesis-tree.md                  假设关系树规范
  graphml-export.md                   GraphML / NetworkX / Gephi 用法
templates/
  mermaid/    research-workflow / theoretical-framework / prisma-flow / did-design / empirical-pipeline (.mmd)
  python/     causal_dag_dagitty / prisma_flow_matplotlib / hypothesis_tree / graphml_export (.py)
  tikz/       causal_dag.tex
tests/        test_skill_structure / test_mermaid_syntax / test_python_templates (.py)
LICENSE  NOTICE  README.md
```

## Source & attribution

本 Skill 完全独立编写。语法与规范参考公开资料：
- Mermaid 官方文档 (https://mermaid.js.org/) — MIT-licensed concept
- DAGitty 因果图视觉惯例 (http://dagitty.net/) — public method
- PRISMA 2020 声明 (http://www.prisma-statement.org/) — public document

Python 代码使用标准 `networkx` + `matplotlib` API；TikZ 使用公开的 `tikz`/`tikz-cd` 语法。无第三方源码复制。

## License

Apache 2.0. See `LICENSE` and `NOTICE`.
