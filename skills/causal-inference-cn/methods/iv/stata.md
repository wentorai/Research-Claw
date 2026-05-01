# IV — Stata 模板

## Setup

```stata
* 安装包
ssc install ivreg2, replace
ssc install ivreghdfe, replace
ssc install ranktest, replace
ssc install weakivtest, replace        // Olea-Pflueger
ssc install reghdfe, replace
```

## 1. 基础 2SLS

```stata
use "data/iv_sample.dta", clear

* Y: 因变量；D: 内生变量；Z1 Z2: 工具；x1 x2: 外生协变量
ivreg2 Y x1 x2 (D = Z1 Z2), robust first
* first 选项强制输出第一阶段；robust 一阶/二阶都用稳健 SE
```

## 2. OLS vs 2SLS 对比

```stata
reg Y D x1 x2, robust
estimates store m_ols

ivreg2 Y x1 x2 (D = Z1 Z2), robust
estimates store m_iv

esttab m_ols m_iv using "out/iv_main.rtf", b(3) se(3) ///
    star(* 0.10 ** 0.05 *** 0.01) keep(D) ///
    mtitles("OLS" "2SLS") replace
```

## 3. 第一阶段 + Olea-Pflueger 有效 F

```stata
* 仅 1 个内生变量时：
ivreg2 Y x1 x2 (D = Z1 Z2), robust

* 关注 ivreg2 输出的：
* - "First-stage regression(s)"
* - "Underidentification test (Kleibergen-Paap LM)"
* - "Weak identification test (Cragg-Donald / Kleibergen-Paap rk Wald F)"

* Olea-Pflueger（更现代）
weakivtest
* 输出 Effective F；与 Olea-Pflueger 临界值比对
```

## 4. 高维 FE + IV

```stata
ivreghdfe Y x1 x2 (D = Z1 Z2), absorb(firm_id year) cluster(province_id) first
```

## 5. Hansen J（仅当工具数 > 内生变量数）

```stata
* ivreg2 默认输出 Hansen J
* H0: 工具集联合外生（在已有 IV 假设下）
* p > 0.10 = 不拒绝，IV 集互相一致
```

## 6. 简化型 (Reduced Form)

```stata
* RF：Z 直接对 Y
reg Y Z1 Z2 x1 x2, robust
* RF 显著 + 第一阶段强 → IV 系数才可信
* 若 RF 不显著但 2SLS 显著，几乎一定是弱 IV 放大
```

## 7. LIML / Fuller (弱工具更稳健的估计)

```stata
ivreg2 Y x1 x2 (D = Z1 Z2), robust liml
ivreg2 Y x1 x2 (D = Z1 Z2), robust fuller(1)
* LIML 在弱工具下偏差更小，可作稳健性
```

## 8. Anderson-Rubin (弱-IV 稳健的推断)

```stata
* 在 ivreg2 的输出中：
* "Anderson-Rubin Wald test" 与 "Stock-Wright LM-S statistic"
* 即便弱 IV，AR 仍给出有效推断
```

## 9. 安慰剂结果变量

```stata
* 选一个 ex-ante 不应被 D 影响的 Y_placebo
ivreg2 Y_placebo x1 x2 (D = Z1 Z2), robust
* 应不显著；若显著，说明 IV 通过其他渠道作用 → 排他性受质疑
```

## 输出解读 tips

- **第一阶段 F**：报告 Kleibergen-Paap rk Wald F（异方差稳健）；> 10 是底线；> 23 较安心（OP 5% bias）。
- **Hansen J p > 0.10**：通过，但**不能把 J 当成排他性证明**。
- **2SLS 系数往往大于 OLS**：常解释为"内生变量被低估了"或 LATE > ATE on compliers；要能说圆。
- **`partial(x1 x2)` 选项**：把外生协变量 partial out，等价但运行更快，注意系数解读不变。
- 报告时三栏：(1) OLS, (2) 2SLS, (3) 第一阶段（F 在表底）。
