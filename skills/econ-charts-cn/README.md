# econ-charts-cn

经济学/金融学/管理学研究专用图表模板集。

## 12 类图表 × 三语言 (Stata / R / Python) × 4 期刊样式

覆盖：系数对比图、事件研究、Bin scatter、边际效应、政策门槛响应（Bunching）、处理组地图、Sankey 资金流、董事网络、政策事件时间序列、层次聚类热图、元分析森林图、多回归对比表。

支持期刊样式：《经济研究》《管理世界》《Journal of Finance》《Management Science》。

## Quick start

```bash
# Python
python templates/python/coefplot.py        # -> coefplot.pdf
python templates/python/event_study.py     # -> event_study.pdf

# R
Rscript templates/r/coefplot.R             # -> coefplot_out.pdf

# Stata
stata -b do templates/stata/coefplot.do    # -> coefplot_out.pdf
```

## Layout

```
econ-charts-cn/
├── SKILL.md
├── references/
├── templates/
│   ├── stata/    (6 .do)
│   ├── r/        (7 .R)
│   └── python/   (8 .py, all runnable)
├── tests/
├── LICENSE
├── NOTICE
└── README.md
```

## Tests

```bash
pip install pytest matplotlib numpy scipy
python3 -m pytest tests/ -v
```

## License

Apache-2.0.
