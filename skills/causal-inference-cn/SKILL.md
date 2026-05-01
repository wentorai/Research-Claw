---
name: causal-inference-cn
description: 面向中国情境的因果推断方法集，覆盖 DiD / RDD / IV / Synthetic Control / PSM 五种识别策略，提供 Stata / R / Python 三语言模板代码与中国数据/政策研究的常见陷阱与稳健性套路。当用户讨论因果推断、双重差分、断点回归、工具变量、合成控制、倾向得分匹配、政策评估，或要在 CSMAR/Wind/CFPS/CHFS 等中国数据上实现识别策略时调用本 Skill。
tags: [causal-inference, econometrics, did, rdd, iv, synthetic-control, psm, stata, r, python, chinese]
version: 0.1.0
author: HaonanAlex
license: Apache-2.0
---

# causal-inference-cn — 中国情境因果推断方法集

本 Skill 为面向中文情境（中国数据、中国政策评估）的研究助手，覆盖 5 种核心因果识别策略，给出 Stata / R / Python 三语言模板代码，以及中国数据/政策研究中的常见陷阱与稳健性套路。

## What it does

- 给出 5 种主流因果识别方法的标准做法 (overview)
- 每种方法配 Stata / R / Python 三套**可直接复用**模板 (~20–40 行)
- 涵盖标准稳健性扩展（平行趋势、带宽敏感性、弱工具检验、安慰剂等）
- 中国情境补丁：CSMAR/Wind/CFPS/CHFS 数据特点、行政区划匹配、政策外生性回应

## Methods covered

| 方法 | 缩写 | 文件夹 | 关键场景 |
|------|------|--------|----------|
| 双重差分 | DiD | `methods/did/` | 政策时点冲击、面板数据 |
| 断点回归 | RDD | `methods/rdd/` | 阈值规则（分数线/年龄线/行政线） |
| 工具变量 | IV | `methods/iv/` | 内生性、反向因果 |
| 合成控制 | SC | `methods/sc/` | 单一处理单位（一省/一市/一国） |
| 倾向得分匹配 | PSM | `methods/psm/` | 横截面选择性偏误 |

## Trigger phrases

中文：因果推断、识别策略、双重差分、DID、平行趋势、断点回归、RDD、工具变量、IV、合成控制法、SCM、倾向得分匹配、PSM、政策评估、政策冲击。

English: causal inference, DiD, RDD, IV, synthetic control, propensity score matching, identification, parallel trends, first stage, weak IV, bandwidth.

## How to use this Skill

1. **确定方法**：先读 `methods/<方法>/overview.md`，确认假设是否成立。
2. **挑语言**：根据用户工作流读 `stata.md` / `r.md` / `python.md` 中的对应模板。
3. **过中国情境关**：套用 `cases/cn-context.md` 中的检查项（行政区划、数据库特点）。
4. **跑稳健性**：按 `cases/robustness-checklist.md` 至少跑 3 项稳健性。
5. **政策评估**：参考 `cases/policy-evaluation.md` 的 SOP 应用到具体政策。

## File map

```
SKILL.md                          (this file)
methods/
  did/   {overview, stata, r, python}.md
  rdd/   {overview, stata, r, python}.md
  iv/    {overview, stata, r, python}.md
  sc/    {overview, stata, r, python}.md
  psm/   {overview, stata, r, python}.md
cases/
  cn-context.md                   中国数据/区划/包生态
  policy-evaluation.md            政策评估 SOP + 假想例
  robustness-checklist.md         稳健性清单
```

## Source & attribution

本 Skill 完全独立编写。方法学叙述参考公开教材：Angrist & Pischke (2009) *Mostly Harmless Econometrics*、Wooldridge (2010) *Econometric Analysis of Cross Section and Panel Data*、Cunningham *Causal Inference: The Mixtape* (https://mixtape.scunning.com/)；代码模板参考各包的公开文档（`reghdfe`, `csdid`, `rdrobust`, `fixest`, `did`, `MatchIt`, `linearmodels`, `DoubleML`, `Synth`, `gsynth` 等）。

仓库 [`Jill0099/causal-inference-mixtape`](https://github.com/Jill0099/causal-inference-mixtape) 提供了组织结构上的概念灵感（仅 README 高层结构），未复制其文本或代码。

## License

Apache 2.0. See `LICENSE` and `NOTICE`.
