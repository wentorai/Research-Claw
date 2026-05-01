* margins_plot.do: replace toy data with your analysis output.
* margins_plot.do —— 边际效应图（交互项 / 二次项）
* 安装包: ssc install reghdfe, replace
*         (margins / marginsplot 是 Stata 内置)
* 运行: stata -b do margins_plot.do  -> margins_plot_out.pdf
* ----------------------------------------------------------------
* 用途: 估计 Y = b1*X + b2*X*Z + ... 后, 画 dY/dX 在 Z 不同取值
*       下的边际效应图, 含 95% CI 阴影带 + Z 的 rug plot.
* ----------------------------------------------------------------
clear all
set more off
set seed 20260501

* ---- 1. 合成数据 ----
set obs 3000
gen id    = ceil(_n / 15)
gen year  = mod(_n - 1, 15) + 2010
gen x     = rnormal(0, 1)
gen z     = rnormal(0, 1)
gen ctrl  = rnormal()
gen y     = 0.30*x + 0.20*x*z + 0.10*z + 0.15*ctrl + rnormal(0, 1)

* ---- 2. 估计含交互项 ----
reg y c.x##c.z ctrl, robust

* ---- 3. margins + marginsplot ----
quietly summarize z, detail
local z_lo = r(p5)
local z_hi = r(p95)

margins, dydx(x) at(z=(`z_lo'(0.25)`z_hi'))

marginsplot,                                          ///
    yline(0, lcolor(gs8) lpattern(dash) lwidth(thin)) ///
    plotopts(lcolor(black) lwidth(medium))            ///
    ciopts(recast(rarea) fcolor(gs12%50) lcolor(none)) ///
    recast(line)                                      ///
    title("")                                         ///
    xtitle("调节变量 Z", size(small))                ///
    ytitle("X 对 Y 的边际效应 dY/dX", size(small))   ///
    note("注: 阴影为 95% CI; 控制变量 ctrl.", size(vsmall)) ///
    graphregion(color(white)) plotregion(color(white)) ///
    scheme(s2mono)

graph export "margins_plot_out.pdf", as(pdf) replace
display "saved: margins_plot_out.pdf"
