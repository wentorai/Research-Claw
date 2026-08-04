# PSM — Stata 模板

## Setup

```stata
* 安装包
ssc install psmatch2, replace
ssc install pstest, replace
ssc install ebalance, replace          // entropy balancing
ssc install cem, replace               // coarsened exact matching
ssc install rbounds, replace           // Rosenbaum sensitivity
* teffects 是 official，无需安装
```

## 1. 数据准备 (横截面 / 行业-年份匹配)

```stata
use "data/firm_panel.dta", clear

* 协变量取处理时点前一期值
* (假设 D=1 在 t=2015，则 X 用 2014 值)

* 行业-年份内匹配的常用做法：先把样本限制在同年同行业
* 简化：保留 2014 年截面做 PSM
keep if year == 2014
```

## 2. 倾向分估计 + 1:1 最近邻匹配

```stata
* psmatch2 一行同时估倾向分 + 匹配 + 输出 ATT
psmatch2 D lnAsset leverage roa age tobinq i.industry, ///
    out(Y) neighbor(1) caliper(0.05) common ate logit

* 输出关键字段：
* - _pscore : 倾向分
* - _weight : 匹配权重
* - _support: 是否在共同支撑
* - r(att)  : ATT 估计
display "ATT  = " r(att) "  SE = " r(seatt)
```

## 3. 平衡检验 (matching diagnostics)

```stata
pstest lnAsset leverage roa age tobinq, ///
    treated(D) graph rubin both
* 输出：处理/对照均值、% bias 减少、t-test、Rubin's B 与 R
* 经验阈值：% bias < 5、Rubin's B < 25 视为平衡
```

## 4. 倾向分密度图

```stata
psgraph
* 自动画处理组与对照组的 _pscore 分布
```

## 5. 多种稳健性匹配

```stata
* 1:k 最近邻
psmatch2 D lnAsset leverage roa age tobinq i.industry, out(Y) n(4) caliper(0.05) ate
estimates store nn4

* Kernel matching
psmatch2 D lnAsset leverage roa age tobinq i.industry, out(Y) kernel ate
estimates store kern

* Mahalanobis
psmatch2 D lnAsset leverage roa age tobinq i.industry, out(Y) mahal(lnAsset roa) ate
estimates store mahal

* Coarsened Exact Matching
cem lnAsset leverage roa (#5) age (#5) tobinq, treatment(D)
reg Y D lnAsset leverage roa age tobinq [iweight = cem_weights], robust
estimates store cem_m
```

## 6. teffects 系列（含 DR / IPW / AIPW）

```stata
* IPW
teffects ipw (Y) (D lnAsset leverage roa age tobinq i.industry, logit), atet
estimates store ipw

* PSM via teffects
teffects psmatch (Y) (D lnAsset leverage roa age tobinq i.industry, logit), ///
    atet nneighbor(1) caliper(0.05)
estimates store tpsm

* AIPW（双重稳健）
teffects aipw (Y lnAsset leverage roa age tobinq) ///
              (D lnAsset leverage roa age tobinq i.industry, logit), atet
estimates store aipw
```

## 7. Entropy balancing

```stata
ebalance D lnAsset leverage roa age tobinq, targets(3)
* targets(3) 表示前三阶矩平衡（均值 / 方差 / 偏度）
reg Y D [pweight = _webal], robust
estimates store ebal
```

## 8. PSM-DID（中国论文最常套路）

```stata
* 第一步：用 t-1 期协变量做 PSM 找配对样本
preserve
keep if year == 2014
psmatch2 D lnAsset leverage roa age tobinq i.industry, out(Y) n(1) caliper(0.05)
keep id _support
keep if _support == 1
tempfile matched
save `matched'
restore

* 第二步：把配对样本回贴到面板，跑 DID
merge m:1 id using `matched', keep(3) nogen
gen post = (year >= 2015)
gen did  = D * post

reghdfe Y did $controls, absorb(id year) cluster(industry)
```

## 9. Rosenbaum bounds (敏感性分析)

```stata
psmatch2 D lnAsset leverage roa age tobinq, out(Y) n(1) caliper(0.05)
rbounds Y if _support == 1, gamma(1(0.1)2)
* gamma 是隐性混淆的强度倍数；输出在哪个 gamma 下 p > 0.05
* gamma 临界 < 1.5 → 结论对未观测混淆敏感
```

## 输出解读 tips

- **% bias reduction**：`pstest` 报告每个变量匹配后 bias 下降幅度，目标 > 80%。
- **Rubin's B / R**：B < 25, R 在 [0.5, 2] → 可接受平衡。
- **共同支撑**：psmatch2 输出 `_support == 0` 的样本数；通常应 < 5%。
- **多种匹配方法 ATT 一致** → 结果稳健；差异大 → 模型敏感、不可发表。
- 报告时建议表格：(1) 平衡前后表，(2) ATT in 5 种匹配方法 (NN1, NN4, kernel, Mahalanobis, CEM)，(3) Rosenbaum bounds 关键 gamma。
