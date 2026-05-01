*===========================================================
* basic_cleaning.do
* CSMAR (国泰安) 数据清洗标准模板 - Stata 版
*
* 流程:
*   1) 载入合成的 minimal CSMAR 数据 (用于自检)
*   2) 样本筛选: 剔金融、剔 ST、剔 IPO 当年、剔 B 股
*   3) 关键变量缺失处理
*   4) 极值缩尾 (winsor2, 1%/99%)
*   5) 输出干净面板
*
* 依赖:
*   ssc install winsor2
*===========================================================

clear all
set more off
set seed 20260501

*-----------------------------------------------------------
* Step 0: 合成 minimal 数据（替代真实 CSMAR 输入）
*   N = 200 stock-year 观测
*   字段: Stkcd, year, IndCd, Trdsta, ListDt, roa, lev, size, growth
*-----------------------------------------------------------
set obs 200

gen long stk_id = mod(_n - 1, 20) + 1
tostring stk_id, replace
gen Stkcd = "00000" + stk_id
replace Stkcd = substr(Stkcd, -6, 6)
* 设置一些 B 股 (开头为 9) 与制造业 / 金融业代码
replace Stkcd = "9" + substr(Stkcd, 2, 5) if mod(_n, 20) == 0
drop stk_id

gen year = 2010 + mod(floor((_n - 1) / 20), 10)

gen IndCd = "C39"
replace IndCd = "J66" if mod(_n, 30) == 0       // 一些金融业
replace IndCd = "K70" if mod(_n, 40) == 0       // 一些房地产
replace IndCd = "C26" if mod(_n, 7) == 0

gen Trdsta = 1
replace Trdsta = 2 if mod(_n, 50) == 0         // 一些 ST

gen ListDt = mdy(1, 1, 2009 + mod(_n, 5))
format ListDt %td

* 财务变量 (含一些极端值)
gen roa = rnormal(0.05, 0.08)
replace roa = 5 if mod(_n, 100) == 0           // 制造一个极端值
replace roa = -3 if mod(_n, 99) == 0
gen lev = runiform(0.1, 0.7)
gen size = rnormal(22, 1.5)
gen growth = rnormal(0.15, 0.30)

* 一些缺失
replace roa = . if mod(_n, 60) == 0

di "=== 原始数据 ==="
sum roa lev size growth
tab IndCd, missing
tab Trdsta, missing

*-----------------------------------------------------------
* Step 1: 样本期窗口
*-----------------------------------------------------------
keep if year >= 2010 & year <= 2019

*-----------------------------------------------------------
* Step 2: 剔除金融业 (CSRC 2001 = I, CSRC 2012 = J)
*-----------------------------------------------------------
gen byte ind_top = substr(IndCd, 1, 1)
drop if ind_top == "I" | ind_top == "J"

* （可选）剔除房地产业
* drop if ind_top == "K"

*-----------------------------------------------------------
* Step 3: 剔除 ST / *ST / PT
*-----------------------------------------------------------
drop if Trdsta != 1

*-----------------------------------------------------------
* Step 4: 剔除 IPO 当年
*-----------------------------------------------------------
drop if (year - year(ListDt)) < 1

*-----------------------------------------------------------
* Step 5: 剔除 B 股 (首位 9 或代码段 20/90)
*-----------------------------------------------------------
drop if substr(Stkcd, 1, 1) == "9"
drop if substr(Stkcd, 1, 2) == "20"

*-----------------------------------------------------------
* Step 6: 关键变量缺失值处理
*-----------------------------------------------------------
drop if missing(roa, lev, size, growth)

*-----------------------------------------------------------
* Step 7: 极值缩尾 (winsor2, 全样本 1% / 99%)
* 需先安装: ssc install winsor2
*-----------------------------------------------------------
capture which winsor2
if _rc == 111 {
    di as error "winsor2 not installed. Run: ssc install winsor2"
    exit 111
}

winsor2 roa lev size growth, replace cuts(1 99)

*-----------------------------------------------------------
* Step 8: 检查面板结构 + 描述性统计
*-----------------------------------------------------------
destring Stkcd, gen(stkcd_num) force
xtset stkcd_num year
xtdescribe

di "=== 清洗后样本 ==="
sum roa lev size growth, detail
tab IndCd
tab year

*-----------------------------------------------------------
* Step 9: 保存
*-----------------------------------------------------------
* save clean_panel.dta, replace

di "=== Clean panel ready. Observations: " _N " ==="
