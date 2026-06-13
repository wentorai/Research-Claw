---
name: publication-figure-cn
description: 面向中文学术期刊（《经济研究》《管理世界》《会计研究》《心理学报》等）的配图规范与 matplotlib 模板集。覆盖三线表、宋体字号、黑白可读 / 色盲友好调色板、7 类常用图（折线 / 柱状 / 散点 / 箱线 / 系数 / 热图 / 直方）+ LaTeX booktabs 表格。当用户绘制学术图表、检查配图是否符合中文期刊规范、或导出 PDF 投稿时调用本 Skill。
tags: [figure, plotting, matplotlib, latex, three-line-table, chinese, publication, colorblind]
version: 0.1.0
author: HaonanAlex
license: Apache-2.0
---

# publication-figure-cn — 中文期刊配图规范 + matplotlib 模板

本 Skill 为面向中文核心期刊（《经济研究》《管理世界》《会计研究》《心理学报》《中国工业经济》《金融研究》等）投稿的作者提供**配图与表格规范**与**可直接复用的 matplotlib 模板**。

## What it does

- 给出中文期刊配图规范全集（字体 / 字号 / 颜色 / 线宽 / 图注 / 比例）
- 三线表（top-rule / middle-rule / bottom-rule）规范 + LaTeX booktabs 与 Word 双方案
- 黑白可读 + 色盲友好调色板（BlackWhite / DarkGrey / DotPattern）
- 7 类常用图模板（折线 / 柱状 / 散点 / 箱线 / 系数 / 热图 / 直方），每个都是 self-contained 可直接 `python xxx.py` 跑出 PDF
- 国内学者高频错误清单（用 Helvetica / 配色花哨 / 线太细 / 标签英文 / 双纵轴乱用）

## When to invoke

- 用户准备给中文 C 刊投稿，需要绘图
- 用户已有图但不确定是否符合中文期刊规范
- 用户在 LaTeX 中写三线表
- 用户问"宋体怎么显示在 matplotlib 里"
- 用户问"DiD/IV 系数图怎么画"

## Files

```
publication-figure-cn/
├── SKILL.md                                # 本文件
├── references/
│   ├── chinese-journal-conventions.md      # 配图规范全集
│   ├── three-line-table.md                 # 三线表规范
│   ├── colorblind-bw.md                    # 黑白 / 色盲调色板
│   ├── figure-types.md                     # 7 类图各自规范
│   └── common-mistakes.md                  # 高频错误
├── templates/
│   ├── matplotlibrc                        # rc 默认配置
│   ├── line_chart.py                       # 折线图
│   ├── bar_chart.py                        # 柱状图
│   ├── coefficient_plot.py                 # 系数图（DiD/IV）
│   ├── scatter_with_fit.py                 # 散点+拟合
│   ├── box_plot.py                         # 箱线图
│   ├── heatmap.py                          # 热图
│   └── three_line_table_latex.tex          # LaTeX booktabs 三线表
├── tests/                                  # pytest 测试
├── LICENSE                                 # Apache-2.0
├── NOTICE
└── README.md
```

## Quick start

```bash
# 1. 看规范
open references/chinese-journal-conventions.md

# 2. 复制 rc 配置到工作目录
cp templates/matplotlibrc ./matplotlibrc

# 3. 复制最相近的模板再改
cp templates/coefficient_plot.py ./my_did_figure.py
python my_did_figure.py        # 跑出 my_did_figure.pdf

# 4. 三线表用 LaTeX
cp templates/three_line_table_latex.tex ./tab_main.tex
```

## Core principles (TL;DR)

1. **字体**：正文宋体（SimSun / Songti SC / Source Han Serif SC），数字与英文 Times New Roman；坐标轴标签字号 9–10pt，刻度 8–9pt
2. **图宽**：单栏 ≤ 8.5cm，双栏 ≤ 17cm，整体不超过版心宽度的 80%
3. **黑白可读**：永远用 marker + linestyle 区分序列，不要只靠颜色
4. **三线表**：只有 top-rule / middle-rule (header 之下) / bottom-rule 三条横线，无竖线、无内部横线
5. **图注 / 表注**：中文，置于图下 / 表下；"注：……" 开头；数据来源单列一行
6. **导出**：PDF 矢量格式，300 DPI；不要交 PNG / JPG

## Anti-patterns

详见 `references/common-mistakes.md`。最高频的 5 条：

1. 用 matplotlib 默认 `tab:blue / tab:orange` 配色 → 黑白打印糊成一团
2. 中文字体没设好，图里一堆方块 → 审稿人会直接打回
3. 双纵轴 (twinx) 比例尺没对齐，制造视觉欺骗
4. 表格画了竖线和很多横线（来自 Excel 默认） → 不是三线表
5. 字号设成 12pt 默认 → 缩到版面后糊成一片
