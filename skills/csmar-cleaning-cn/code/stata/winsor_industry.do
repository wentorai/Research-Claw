*===========================================================
* winsor_industry.do
* 行业内缩尾 (winsor2 by industry) 完整模板
*
* 比较三种粒度: 全样本 / 按年 / 按行业 / 按行业-年
* 输出: 同一变量在 4 种粒度下的统计量对照
*
* 依赖: ssc install winsor2
*===========================================================

clear all
set more off
set seed 20260501

*-----------------------------------------------------------
* Step 0: 合成 minimal 数据
*   - 5 个行业 (IndCd 大类), 8 年, 25 公司 = 200 obs (缩减后约 180)
*   - roa 在不同行业有不同分布 (制造业波动大, 公用事业波动小)
*-----------------------------------------------------------
set obs 200

gen long stk_id = mod(_n - 1, 25) + 1
tostring stk_id, replace
gen Stkcd = "00000" + stk_id
replace Stkcd = substr(Stkcd, -6, 6)
drop stk_id

gen year = 2014 + mod(floor((_n - 1) / 25), 8)

gen byte ind_pick = mod(_n, 5)
gen IndCd = ""
replace IndCd = "C26" if ind_pick == 0          // 化学原料
replace IndCd = "C27" if ind_pick == 1          // 医药制造
replace IndCd = "C39" if ind_pick == 2          // 电子设备
replace IndCd = "D44" if ind_pick == 3          // 电力
replace IndCd = "F51" if ind_pick == 4          // 批发
drop ind_pick

* 不同行业的 roa 噪声水平不同
gen byte ind_first = real(substr(IndCd, 2, 1))
gen roa_sigma = 0.05 + 0.03 * mod(ind_first, 5)
gen roa = rnormal(0.06, roa_sigma)
* 制造一些行业内极端值
replace roa = roa + 2.5 if mod(_n, 70) == 0
replace roa = roa - 2.0 if mod(_n, 65) == 0
drop roa_sigma ind_first

*-----------------------------------------------------------
* Step 1: 备份原始 roa
*-----------------------------------------------------------
gen roa_raw = roa

*-----------------------------------------------------------
* Step 2a: 全样本缩尾
*-----------------------------------------------------------
capture which winsor2
if _rc == 111 {
    di as error "winsor2 not installed. Run: ssc install winsor2"
    exit 111
}

winsor2 roa_raw, suffix(_pool) cuts(1 99)

*-----------------------------------------------------------
* Step 2b: 按年缩尾
*-----------------------------------------------------------
winsor2 roa_raw, suffix(_year) cuts(1 99) by(year)

*-----------------------------------------------------------
* Step 2c: 按行业大类缩尾
*-----------------------------------------------------------
gen ind_top = substr(IndCd, 1, 1)
winsor2 roa_raw, suffix(_ind) cuts(1 99) by(ind_top)

*-----------------------------------------------------------
* Step 2d: 按行业-年缩尾
*-----------------------------------------------------------
winsor2 roa_raw, suffix(_indyr) cuts(1 99) by(ind_top year)

*-----------------------------------------------------------
* Step 3: 对照表
*-----------------------------------------------------------
di _newline "=== 缩尾对照 (mean / sd / min / max / p1 / p99) ==="
foreach v in roa_raw roa_raw_pool roa_raw_year roa_raw_ind roa_raw_indyr {
    qui sum `v', detail
    di "`v'  N=" r(N) " mean=" %6.3f r(mean) " sd=" %6.3f r(sd) ///
       " min=" %6.3f r(min) " max=" %6.3f r(max) ///
       " p1=" %6.3f r(p1) " p99=" %6.3f r(p99)
}

*-----------------------------------------------------------
* Step 4: 行业内的极端值是否被压住 (按 ind_top 看 max)
*-----------------------------------------------------------
di _newline "=== 各行业内 roa_raw_ind (按行业缩尾) 的最大值 ==="
bysort ind_top: egen max_pool = max(roa_raw_pool)
bysort ind_top: egen max_ind  = max(roa_raw_ind)

* 用一行汇总每个行业
preserve
    keep ind_top max_pool max_ind
    duplicates drop ind_top, force
    list, sep(0)
restore

*-----------------------------------------------------------
* Step 5: 推荐做法注释
*-----------------------------------------------------------
* 主回归: 全样本 1%/99% 缩尾 (roa_raw_pool)
* 稳健性 1: 按行业缩尾 (roa_raw_ind)
* 稳健性 2: 按行业-年缩尾 (roa_raw_indyr) - 仅在样本量足够时
* 谨慎: 子样本回归不再二次缩尾, 用主回归同一份缩尾值

di _newline "=== Done. 推荐主回归用 roa_raw_pool, 稳健性用 roa_raw_ind ==="
