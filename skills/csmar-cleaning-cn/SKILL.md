---
name: csmar-cleaning-cn
description: CSMAR (国泰安) 数据清洗标准 SOP，覆盖高频用表 / 通用清洗规则（ST 剔除、IPO 当年剔除、金融行业处理、缺失值）/ 缩尾标准 (winsorize 1%/5%) / 公司 ID 变更追踪 / CSRC 行业代码映射 / 时间对齐 / 国内学者常见陷阱。提供 Stata / R / Python 三语言模板。当用户处理 CSMAR 数据、构建经管类面板数据、或诊断面板数据问题时调用本 Skill。
tags: [csmar, data-cleaning, panel-data, finance, accounting, china, stata, r, python, winsorize]
version: 0.1.0
author: HaonanAlex
license: Apache-2.0
---

# csmar-cleaning-cn — CSMAR 国泰安数据清洗 SOP

本 Skill 面向使用 **CSMAR (国泰安, China Stock Market & Accounting Research Database)** 进行实证会计 / 金融 / 公司治理研究的中文研究者，提供一套标准化的清洗流程 (SOP)，把"导入原始库表 → 输出可上跑回归的干净面板"这条链路上的踩坑点显式化。

## What it does

- 列出实证经管研究最高频使用的 CSMAR 库表与关键字段（`references/csmar-tables.md`）
- 给出通用清洗规则（删 ST/PT、剔金融业、剔 IPO 当年、缺失值、上市公司 ID 变更）（`references/cleaning-rules.md`）
- 标准化缩尾选择：1% / 5%、按年/按行业/全样本（`references/winsorize-standard.md`）
- 处理公司股票代码变更、借壳、退市的 ID 追踪（`references/id-tracking.md`）
- CSRC 2012 vs 2001 行业代码映射、制造业 C13–C43 子门类（`references/industry-codes.md`）
- 财报年度 vs 自然年、季报年化、月度/日度对齐（`references/time-alignment.md`）
- 国内学者高频踩坑（`references/pitfalls.md`）
- Stata / R / Python 三语言**可直接跑**的清洗模板（`code/`）

## When to use

调用本 Skill 的典型情形：

- 用户提到 **CSMAR / 国泰安 / Stkcd / Symbol / TRD_Dalyr / FS_Combas / FS_Comins** 等关键词
- 用户在做 A 股实证（公司治理、盈余管理、信息披露、ESG、股价同步性、IPO、SEO、并购等）
- 用户在构建经管类面板数据并询问"要不要剔金融业？""怎么缩尾？""上市公司代码变了怎么处理？"
- 用户面板回归出现明显异常值、不平衡面板、IPO 当年观测过多等症状
- 用户准备投国内 C 刊 / SSCI 财会金融期刊，需要按惯例做样本筛选

## Skill layout

```
csmar-cleaning-cn/
├── SKILL.md                          ← 本文件
├── README.md                         ← 用户视角入门
├── references/                       ← 知识库（中文）
│   ├── csmar-tables.md               高频用表清单
│   ├── cleaning-rules.md             通用清洗规则
│   ├── winsorize-standard.md         缩尾标准
│   ├── id-tracking.md                公司 ID 变更
│   ├── industry-codes.md             CSRC 行业代码
│   ├── time-alignment.md             时间对齐
│   └── pitfalls.md                   常见陷阱
└── code/                             ← 三语言模板
    ├── stata/
    │   ├── basic_cleaning.do
    │   └── winsor_industry.do
    ├── r/basic_cleaning.R
    └── python/basic_cleaning.py
```

## Highest-frequency tables (quick reference)

| 库表英文名 | 中文 | 频率 | 关键字段 |
|---|---|---|---|
| `TRD_Dalyr` | 个股交易日数据 | 日 | `Stkcd, Trddt, Clsprc, Dretwd, Dsmvosd` |
| `TRD_Mnth` | 个股交易月数据 | 月 | `Stkcd, Trdmnt, Mclsprc, Mretwd, Msmvosd` |
| `FS_Combas` | 资产负债表（合并） | 季/年 | `Stkcd, Accper, A001000000 (资产总计), A002000000 (负债)` |
| `FS_Comins` | 利润表（合并） | 季/年 | `Stkcd, Accper, B001100000 (营业收入), B002000000 (净利润)` |
| `FS_Comscfd` | 现金流量表（合并直接法） | 季/年 | `Stkcd, Accper, C001000000` 系列 |
| `FN_Fn041` | 财务指标—相对价值类 | 年 | `Stkcd, Accper, ROA, ROE, EPS` |
| `EN_EnterpriseInfo` | 上市公司基本信息 | 截面 | `Stkcd, ListDt, IndCd, EstDt` |
| `CG_Ybasic` | 公司治理年度基本表 | 年 | `Stkcd, Reptdt, Y0301a (董事人数), Y1101b (独董)` |
| `STK_MKT_DalyR` | A 股市场日度收益（含市场指数） | 日 | `Trddt, Cdretwdos (流通市值加权)` |

> 字段名以 CSMAR 最新版数据手册为准；以上为长期沿用的命名约定。

## Standard cleaning pipeline (cookbook)

实证会计 / 金融论文样本筛选的"标准菜单"（按惯例顺序）：

1. **样本期窗口** — 按研究设计选定（常见 1998–2023，避开 1990s 早期数据质量问题）
2. **剔除金融业** — 行业代码 J（CSRC 2012）或 I（CSRC 2001）
3. **剔除 ST / *ST / PT 公司** — 通过 `TRD_Dalyr` 的 `Trdsta` 字段（交易状态码）
4. **剔除 IPO 当年观测** — `Trddt - ListDt < 1 year` 全部丢
5. **剔除 B 股 / H 股双重上市样本**（视研究设计）— `Stkcd` 首位为 9 的为 B 股
6. **关键变量缺失值处理** — 一般直接删除（不可插补盈利等关键变量）
7. **缩尾极值** — 连续型变量按 1% / 99% 缩尾（详见 `winsorize-standard.md`）
8. **检查面板平衡度** — `xtset Stkcd year` + `xtdescribe` 输出
9. **保存中间数据** — `.dta` / `.parquet` 格式 + 一份变量字典

## Three-language templates

每条样本筛选规则在 Stata / R / Python 都有对应实现：

- **Stata**：`code/stata/basic_cleaning.do` (载入 + 清洗 + 保存)；`code/stata/winsor_industry.do` (`winsor2` 行业内缩尾)
- **R**：`code/r/basic_cleaning.R` (`dplyr` + `DescTools::Winsorize`)
- **Python**：`code/python/basic_cleaning.py` (`pandas` + `scipy.stats.mstats.winsorize`)

代码模板均包含合成 minimal 数据用于自检，可独立运行。

## Common pitfalls (must read before regression)

详见 `references/pitfalls.md`。最高频四个：

1. **剔金融业但忘记剔房地产 / 类金融** —— 银行业、保险业之外，K 房地产业是否剔有学派分歧
2. **`Stkcd` 当成不可变 ID** —— 借壳上市后 `Stkcd` 不变但公司本质已变
3. **季报年化口径混乱** —— `Accper` 的 03-31 / 06-30 / 09-30 / 12-31 不能直接相加
4. **缩尾在子样本回归前 vs 后做** —— 标准做法是**全样本统一缩尾**，子样本不再二次缩尾

## License & data access

- 本 Skill 代码 / 文档：Apache 2.0
- **CSMAR 数据本身**：商业数据库，需机构订阅。本 Skill 不分发任何 CSMAR 数据，仅提供清洗代码。
- 字段名 / 表名引用自 CSMAR 公开数据手册（官网免费下载）。
