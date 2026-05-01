* eventdd.do: replace toy data with your analysis output.
* eventdd.do —— DiD 事件研究图（动态处理效应）
* 安装包: ssc install eventdd, replace
*         ssc install reghdfe, replace
*         ssc install ftools, replace
* 运行: stata -b do eventdd.do  -> eventdd_out.pdf
* ----------------------------------------------------------------
* 用途: 对处理组在政策时点前后逐期估计动态效应, 95% CI,
*       基期 t = -1 归零, 处理时点画垂直虚线, 0 参考线.
* ----------------------------------------------------------------
clear all
set more off
set seed 20260501

* ---- 1. 合成 staggered DiD 面板 ----
set obs 4000
gen id   = ceil(_n / 20)
bysort id: gen year = 2010 + _n - 1
gen treat_year = .
replace treat_year = 2017 + mod(id, 5) if mod(id, 2) == 0
gen post = (year >= treat_year) & !missing(treat_year)
gen rel  = year - treat_year if !missing(treat_year)

gen y = 0.50 * (rel >= 0) * (1 + 0.3*rel) ///
       + rnormal(0, 1) + 0.05*year
replace y = rnormal(0, 1) + 0.05*year if missing(treat_year)

xtset id year

* ---- 2. eventdd ----
* eventdd 自动构建 lead/lag dummies, t = -1 为基期, 报告 95% CI
eventdd y, ///
    timevar(rel) ///
    method(fe, cluster(id)) ///
    ci(rcap) ///
    lags(5) leads(4) ///
    accum ///
    graph_op(                                                        ///
        xline(-0.5, lcolor(gs8) lpattern(longdash) lwidth(thin))    ///
        yline(0,   lcolor(gs8) lpattern(dash)   lwidth(thin))       ///
        xtitle("距政策实施年份(年)", size(small))                   ///
        ytitle("处理效应估计", size(small))                          ///
        graphregion(color(white)) plotregion(color(white))           ///
        legend(off)                                                  ///
        scheme(s2mono)                                               ///
    )

graph export "eventdd_out.pdf", as(pdf) replace
display "saved: eventdd_out.pdf"
