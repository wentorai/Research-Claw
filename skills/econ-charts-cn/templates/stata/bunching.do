* bunching.do: replace toy data with your analysis output.
* bunching.do —— 政策门槛响应 / Bunching estimator
* 安装包: ssc install bunching, replace        (Andresen, 2018)
*   或自实现 Chetty et al. (2011) 风格
* 运行: stata -b do bunching.do  -> bunching_out.pdf
* ----------------------------------------------------------------
* 用途: 在政策门槛 (cutoff = 0) 处, 画申报值的密度直方图,
*       看是否存在"扎堆", 用门槛外多项式拟合反事实分布.
* ----------------------------------------------------------------
clear all
set more off
set seed 20260501

* ---- 1. 合成 bunching 数据 ----
set obs 10000
gen latent = rnormal(0, 1.5)
gen z = latent
gen pushed = (latent > -0.5) & (latent < 0) & (runiform() < 0.6)
replace z = runiform() * 0.5 if pushed == 1

* ---- 2. 直方图 + bunching window ----
local bw   = 0.05
local lo   = -2
local hi   = 2

twoway (histogram z if z >= `lo' & z <= `hi',                 ///
        width(`bw') frequency                                  ///
        fcolor(gs10) lcolor(black) lwidth(vthin))              ///
       (function y = 600*normalden(x, 0, 1.5),                 ///
        range(`lo' `hi') lcolor(black) lpattern(dash) lwidth(medthin)), ///
    xline(0, lcolor(black) lwidth(thin))                       ///
    xline(-0.5, lcolor(gs8) lpattern(longdash) lwidth(thin))  ///
    xline(0.5,  lcolor(gs8) lpattern(longdash) lwidth(thin))  ///
    xlabel(`lo'(0.5)`hi', labsize(small))                      ///
    xtitle("申报值 z (cutoff = 0)", size(small))              ///
    ytitle("频数", size(small))                                ///
    legend(order(1 "实际密度" 2 "反事实正态拟合") rows(2)      ///
           size(vsmall) region(lcolor(none)))                  ///
    note("注: 灰色区间 [-0.5, 0.5] 为 bunching window.", size(vsmall)) ///
    graphregion(color(white)) plotregion(color(white))         ///
    scheme(s2mono)

* ---- 3. Bunching mass 估计 ----
quietly count if z > -0.5 & z < 0.5
local actual = r(N)
quietly count if latent > -0.5 & latent < 0.5
local cf = r(N)
local b_mass = `actual' - `cf'
display "Estimated bunching mass = `b_mass' (bias toward cutoff)"

graph export "bunching_out.pdf", as(pdf) replace
display "saved: bunching_out.pdf"
