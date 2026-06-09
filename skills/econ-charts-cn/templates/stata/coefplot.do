* coefplot.do: replace toy data with your analysis output.
* coefplot.do —— 多回归系数横向对比图
* 安装包: ssc install coefplot, replace
* 运行: stata -b do coefplot.do  -> coefplot_out.pdf
* ----------------------------------------------------------------
* 用途: 把 4 个模型（基准 / +公司控制 / +年度 FE / +行业 FE）
*       的核心系数 x1 与 x2 对比横向画在一张图里, 95% CI.
* ----------------------------------------------------------------
clear all
set more off
set seed 20260501

* ---- 1. 合成数据 ----
set obs 2000
gen id    = ceil(_n / 10)
gen year  = mod(_n - 1, 10) + 2010
gen ind   = mod(id, 6) + 1
gen x1    = rnormal(0, 1)
gen x2    = rnormal(0, 1)
gen ctrl1 = rnormal()
gen ctrl2 = rnormal()
gen y     = 0.30*x1 - 0.15*x2 + 0.20*ctrl1 + 0.10*ctrl2 ///
            + 0.05*year + rnormal(0, 1)

* ---- 2. 四个模型 ----
quietly {
    reg y x1 x2, robust
    estimates store m1

    reg y x1 x2 ctrl1 ctrl2, robust
    estimates store m2

    reghdfe y x1 x2 ctrl1 ctrl2, absorb(year) cluster(id)
    estimates store m3

    reghdfe y x1 x2 ctrl1 ctrl2, absorb(year ind) cluster(id)
    estimates store m4
}

* ---- 3. coefplot ----
coefplot (m1, label("(1) 基准"))     ///
        (m2, label("(2) +公司控制")) ///
        (m3, label("(3) +年度 FE"))   ///
        (m4, label("(4) +年度+行业 FE")), ///
    keep(x1 x2)                                  ///
    horizontal                                    ///
    xline(0, lcolor(gs8) lpattern(dash) lwidth(thin)) ///
    levels(95)                                    ///
    msymbol(O) msize(small)                      ///
    ciopts(lwidth(medthin) lcolor(black))        ///
    coeflabels(x1 = "核心解释变量 X1" x2 = "辅助变量 X2") ///
    xtitle("回归系数 (95% CI)", size(small))     ///
    ytitle("")                                   ///
    legend(rows(2) size(vsmall) region(lcolor(none))) ///
    graphregion(color(white)) plotregion(color(white)) ///
    scheme(s2mono)

graph export "coefplot_out.pdf", as(pdf) replace
display "saved: coefplot_out.pdf"
