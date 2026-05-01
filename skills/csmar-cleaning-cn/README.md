# csmar-cleaning-cn

CSMAR (国泰安) 数据清洗标准 SOP — Stata / R / Python 三语言模板。

## 适用场景

- 用 CSMAR 做 A 股实证会计 / 公司金融 / 公司治理研究
- 处理面板数据时遇到 ST 剔除、IPO 当年剔除、缩尾、行业代码、公司 ID 变更等问题
- 投稿国内 C 刊或 SSCI 财会金融期刊，需要符合学界惯例的样本筛选

## 包含什么

- `SKILL.md` — Skill 入口，含 description / 触发条件
- `references/` — 7 篇知识文档 (中文)
  - `csmar-tables.md` — 高频用表清单与字段
  - `cleaning-rules.md` — 通用清洗规则 (剔金融、ST、IPO 当年等)
  - `winsorize-standard.md` — 缩尾标准 (1%/99%, 三语言对照)
  - `id-tracking.md` — 公司 ID 变更追踪
  - `industry-codes.md` — CSRC 2012 / 2001 行业代码
  - `time-alignment.md` — 财报时滞 / 频率转换
  - `pitfalls.md` — 14 个高频陷阱
- `code/` — 可独立运行的清洗模板
  - `stata/basic_cleaning.do`、`stata/winsor_industry.do`
  - `r/basic_cleaning.R`
  - `python/basic_cleaning.py`
- `tests/` — Skill 结构自检 (pytest)

## 快速开始

```bash
# Python
python code/python/basic_cleaning.py

# R
Rscript code/r/basic_cleaning.R

# Stata
stata -b do code/stata/basic_cleaning.do
```

每个脚本都用合成的 minimal 数据自跑一遍，不需要真实 CSMAR 数据。

## 测试

```bash
python3 -m pytest tests/ -v
```

## 数据访问

CSMAR 是商业数据库，**本 Skill 不分发任何 CSMAR 数据**。需通过所在机构图书馆订阅访问 [csmar.com](https://www.csmar.com)。

## License

- 代码 / 文档：Apache 2.0
- 字段名 / 表名引用自 CSMAR 公开数据手册
