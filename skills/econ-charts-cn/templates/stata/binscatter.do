* binscatter.do: replace toy data with your analysis output.
* binscatter.do —— Bin scatter (Cattaneo binsreg / Stepner binscatter2)
* 安装包: ssc install binscatter, replace
*         ssc install binsreg,    replace
*         ssc install binscatter2, replace
* 运行: stata -b do binscatter.do  -> binscatter_out.pdf
* ----------------------------------------------------------------
* 用途: 大样本散点（>10000 obs）按 X 分箱后取均值, 看 Y vs X
*       的非参形状, 控制协变量 + 一阶/二阶多项式拟合, 95% CI.
* ----------------------------------------------------------------
clear all
set more off
set seed 20260501

* ---- 1. 合成大样本数据 ----
set obs 20000
gen x      = rnormal(0, 1.5)
gen ctrl1  = rnormal()
gen ctrl2  = rnormal()
gen y      = 0.4*x + 0.15*x^2 + 0.20*ctrl1 - 0.10*ctrl2 ///
             + rnormal(0, 1.2)

* ---- 2. binsreg (Cattaneo 等, 推荐) ----
binsreg y x ctrl1 ctrl2,             ///
    polyreg(2)                       ///
    cb(2 2)                          ///
    line(2 2)                        ///
    ci(2 2)                          ///
    nbins(25)                        ///
    plotxrange(-3 3)                 ///
    graphregion(color(white))        ///
    plotregion(color(white))         ///
    title("")                        ///
    xtitle("X (标准化)", size(small)) ///
    ytitle("Y", size(small))         ///
    note("注: 25 箱, 二阶多项式拟合 + 95% CI 阴影带; 控制 ctrl1, ctrl2.", size(vsmall))

graph export "binscatter_out.pdf", as(pdf) replace

* ---- 备选: 经典 Stepner binscatter ----
* binscatter y x, controls(ctrl1 ctrl2) nquantiles(25) linetype(qfit)

display "saved: binscatter_out.pdf"
