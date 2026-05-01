* multiple_regs_table.do: replace toy data with your analysis output.
* multiple_regs_table.do —— 一键多列回归三线表
* 安装包: ssc install estout,    replace
*         ssc install outreg2,   replace
*         ssc install reghdfe,   replace
*         ssc install ftools,    replace
* 运行: stata -b do multiple_regs_table.do  -> table_main.tex
* ----------------------------------------------------------------
* 用途: 4 列基准 / 加控制 / 加 FE / 子样本 一键导出 LaTeX 三线表
*       (booktabs 风格), 含 ★ 显著性, N, R^2, FE 控制行.
* ----------------------------------------------------------------
clear all
set more off
set seed 20260501

* ---- 1. 合成数据 ----
set obs 3000
gen id    = ceil(_n / 15)
gen year  = mod(_n - 1, 15) + 2010
gen ind   = mod(id, 10) + 1
gen x1    = rnormal(0, 1)
gen x2    = rnormal(0, 1)
gen size  = rnormal(8, 1.2)
gen lev   = runiform(0, 0.8)
gen treat = (id <= 100)
gen y     = 0.30*x1 - 0.15*x2 + 0.40*size - 0.20*lev + 0.05*year + ///
            rnormal(0, 1)

* ---- 2. 四个模型 ----
quietly {
    eststo m1: reg y x1 x2, robust
    eststo m2: reg y x1 x2 size lev, robust
    eststo m3: reghdfe y x1 x2 size lev, ///
        absorb(year ind) cluster(id)
    eststo m4: reghdfe y x1 x2 size lev if treat == 1, ///
        absorb(year ind) cluster(id)
}

* ---- 3. esttab 导出三线表 (LaTeX booktabs) ----
esttab m1 m2 m3 m4 using "table_main.tex", replace        ///
    booktabs                                               ///
    se(2) b(3)                                             ///
    star(* 0.10 ** 0.05 *** 0.01)                          ///
    keep(x1 x2 size lev)                                   ///
    order(x1 x2 size lev)                                  ///
    coeflabels(x1 "X1 (核心)" x2 "X2"                     ///
               size "公司规模" lev "杠杆率")              ///
    mtitles("(1) 基准" "(2) +控制" "(3) +双 FE" "(4) 处理组") ///
    stats(N r2_a, fmt(0 3) labels("观测数" "调整 R^2"))   ///
    indicate("年度 FE = year#" "行业 FE = ind#",            ///
             labels("\checkmark" ""))                      ///
    nonotes nogaps                                         ///
    title("基准回归结果\label{tab:main}")                 ///
    addnotes("括号内为聚类到公司层面的稳健标准误."         ///
             "*, **, *** 分别表示 10\%, 5\%, 1\% 显著.")

display "saved: table_main.tex"
