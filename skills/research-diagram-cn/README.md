# research-diagram-cn

研究流程图 / 因果 DAG / PRISMA / 假设关系图 / 合作引用网络（GraphML） 自动生成 Skill。

三条互补路线：

- **Mermaid**（`templates/mermaid/`）— Markdown 原生，最易展示
- **Python (networkx + matplotlib)**（`templates/python/`）— 论文 PDF/PNG 插图
- **LaTeX TikZ**（`templates/tikz/`）— 高分辨率投稿级矢量图

完整说明见 [`SKILL.md`](SKILL.md)。

## 快速开始

```bash
# 试 Python 模板
python3 templates/python/causal_dag_dagitty.py
python3 templates/python/prisma_flow_matplotlib.py
python3 templates/python/hypothesis_tree.py
python3 templates/python/graphml_export.py

# 试 Mermaid（粘到 https://mermaid.live/）
cat templates/mermaid/research-workflow.mmd

# 跑测试
python3 -m pytest tests/ -v
```

## 许可证

Apache 2.0。详见 [`LICENSE`](LICENSE) 与 [`NOTICE`](NOTICE)。
