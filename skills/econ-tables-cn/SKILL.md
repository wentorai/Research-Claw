---
name: econ-tables-cn
description: 经济学/金融学/管理学研究专用三线表升级版，覆盖 estout (Stata) / modelsummary (R) / stargazer (Python) 三语言联动。涵盖 robust SE / clustered SE / 双向固定效应 / DiD / IV-2SLS / 描述统计 等经管高频表格。支持《经济研究》《管理世界》《Journal of Finance》《Management Science》4 种期刊格式自动切换（显著性符号 / 列对齐 / 字号 / N + R² 标注）。当用户需要导出回归结果到论文、对比多个模型、或按特定期刊格式调整表格时调用本 Skill。
tags: [econ, finance, management, tables, regression, stata, r, python, latex, three-line-table]
version: 0.1.0
author: HaonanAlex
license: Apache-2.0
---

# econ-tables-cn — 经管研究三线表升级版

面向经济学 / 金融学 / 管理学研究者的三线表生成 Skill，覆盖 Stata / R / Python 三语言。

## What it does

- 三语言三线表模板：Stata `estout/esttab` + R `modelsummary/fixest::etable` + Python `stargazer/linearmodels`
- 覆盖经管高频场景：robust SE / clustered SE (firm/year/firm-year/Driscoll-Kraay/Newey-West) / 双向固定效应 / DiD / IV-2SLS / 描述统计
- 4 期刊样式自动切换：《经济研究》《管理世界》《Journal of Finance》《Management Science》
- 多列模型并列（OLS vs FE vs IV vs DiD）对比规范
- LaTeX（论文用）+ HTML（PPT 用）双格式输出
- 中文学者高频错误清单（系数 vs SE 同列 / N 漏报 / R² 误读 / FE 漏标 / 显著性符号不一致）

## When to invoke

- 用户跑完回归想把结果导出到论文（Stata / R / Python）
- 用户要对比多个模型（OLS、FE、IV、DiD）放在同一张表里
- 用户问"clustered SE 怎么标 / 双向 FE 怎么报告"
- 用户问"《经济研究》/《管理世界》/ JF / MS 表格格式什么样"
- 用户要做描述统计表 / 第一阶段 IV / DiD 平行趋势表

## Files

```
econ-tables-cn/
├── SKILL.md                                # 本文件
├── references/
│   ├── table-anatomy.md                    # 三线表解剖
│   ├── se-types.md                         # SE 类型大全
│   ├── significance-conventions.md         # 显著性符号 + 期刊偏好
│   ├── journal-formats.md                  # 4 期刊格式详解
│   ├── multi-column-design.md              # 多列设计
│   └── common-mistakes.md                  # 高频错误
├── templates/
│   ├── stata/                              # 7 个 .do 文件
│   ├── r/                                  # 6 个 .R 文件
│   └── python/                             # 5 个 .py 文件
├── tests/                                  # pytest
├── LICENSE / NOTICE / README.md
```

## Quick start

```bash
# 1. 看期刊格式
open references/journal-formats.md

# 2. 选最贴近的模板，复制后改
cp templates/stata/multi_model.do      ./tab_main.do      # Stata
cp templates/r/fixest_table.R          ./tab_main.R       # R
cp templates/python/linearmodels_table.py ./tab_main.py   # Python

# 3. 跑出 .tex / .html
stata -b do tab_main.do
Rscript tab_main.R
python tab_main.py
```

## Core principles (TL;DR)

1. **三线表**：top-rule（粗）/ mid-rule（细，header 之下）/ bottom-rule（粗），无竖线、无内部冗余横线
2. **系数与 SE 同单元格的两行**：第一行系数 + 显著性符号；第二行括号中 SE
3. **必报指标**：N（样本量）、R²（OLS）/ within-R²（FE）/ Pseudo-R²（Logit）/ KP-F（IV）/ Hansen-J（GMM）
4. **FE 标注**：用 ✓ / Yes 在表底独立行表示；不要写在系数行
5. **聚类 SE**：表注必须明确 "Standard errors clustered at the firm-year level"
6. **显著性**：经管/金融默认 `*=10% / **=5% / ***=1%`；JF 偏好同款；MS 与 JF 一致；《经济研究》《管理世界》同款
7. **多列对齐**：同一控制变量同列；列宽用 `D{.}{.}` 对齐小数点
8. **导出**：LaTeX 用 booktabs；HTML 用于 PPT、汇报；不要交 Word 默认表

## Anti-patterns

详见 `references/common-mistakes.md`。最高频 5 条：

1. 系数和 SE 写在两列 → 应同列上下两行
2. 报告 N 但不报 R² / 报告 R² 但不报 N
3. FE 写到表头但没在表底独立行打 ✓
4. 聚类层级未在表注说明
5. 多列模型的控制变量集不一致但表里看不出来
