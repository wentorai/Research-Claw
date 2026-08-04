# RDD — Stata 模板

## Setup

```stata
* 安装包
ssc install rdrobust, replace
ssc install rddensity, replace
ssc install rdpower, replace
ssc install lpdensity, replace      // rddensity 依赖
```

## 1. RDD 散点图（必做的第一张图）

```stata
use "data/rdd_sample.dta", clear

* X = running variable（已中心化到阈值，X = 0 即阈值）
* Y = 因变量
rdplot Y X, c(0) p(1) ///
    graph_options(title("RD plot, p=1") xtitle("Score - cutoff") ytitle("Y"))
```

## 2. Sharp RDD 主估计（CCT MSE-optimal 带宽）

```stata
rdrobust Y X, c(0) p(1) kernel(triangular) bwselect(mserd)
* 默认输出：Conventional / Bias-corrected / Robust 三套点估计 + CI
* 报告时通常引用 Robust 行
```

## 3. Fuzzy RDD（处理概率在阈值跳跃但不到 1）

```stata
* 假设 D 是真实处理状态
rdrobust Y X, c(0) fuzzy(D) p(1) kernel(triangular) bwselect(mserd)

* 等价 IV：Z = 1[X>=0] 作为 D 的工具变量
gen Z = (X >= 0)
ivregress 2sls Y (D = Z) X if abs(X) < 0.5, robust
```

## 4. McCrary 密度断点检验

```stata
rddensity X, c(0) plot
* H0: X 的密度在 c 处连续。p > 0.10 → 通过
* 若 p < 0.05，强烈怀疑被操纵，RDD 失效
```

## 5. 协变量平衡

```stata
foreach v of varlist age female edu {
    di as text "=== Covariate: `v' ==="
    rdrobust `v' X, c(0) p(1) bwselect(mserd)
}
* 任何一个协变量在 c 处显著跳跃 → 连续性假设受质疑
```

## 6. 带宽稳健性扫描

```stata
matrix R = J(7, 4, .)
local i = 1
foreach mult in 0.5 0.75 1.0 1.25 1.5 1.75 2.0 {
    qui rdrobust Y X, c(0) p(1) h(`mult'*0.3) kernel(triangular)
    matrix R[`i', 1] = `mult'
    matrix R[`i', 2] = e(tau_cl)
    matrix R[`i', 3] = e(se_tau_cl)
    matrix R[`i', 4] = e(N)
    local ++i
}
matlist R, format(%9.3f) ///
    rownames("0.5h" "0.75h" "h" "1.25h" "1.5h" "1.75h" "2h") ///
    cnames("mult" "tau" "se" "N")
```

## 7. 多项式阶数稳健

```stata
foreach p in 1 2 3 {
    di as text "=== Polynomial order p = `p' ==="
    rdrobust Y X, c(0) p(`p') kernel(triangular) bwselect(mserd)
}
* p=1 是首选；p>=3 易过拟合 (Gelman-Imbens 2019)
```

## 8. Donut hole 测试

```stata
foreach eps in 0.02 0.05 0.10 {
    qui rdrobust Y X if abs(X) > `eps', c(0) p(1) bwselect(mserd)
    di "eps = `eps' : tau = " %6.3f e(tau_cl) "  p = " %6.3f e(pv_rb)
}
```

## 输出解读 tips

- **报告 Robust CI 而非 Conventional**——Conventional CI 在 MSE-optimal 带宽下覆盖率有偏。
- **`Order Loc. Poly. (p)` = 1** 是默认首选，不要随便改成 2 之上。
- **`BW est. (h)`**：MSE 最优带宽。如果 `Eff. N`（等效样本）小于 80，结果脆弱。
- **kernel(triangular)** 是默认；epanechnikov/uniform 仅作稳健性对照。
- **manipulation test 的 T 统计量** 不显著（绝对值 < 1.96）→ 通过 McCrary。
