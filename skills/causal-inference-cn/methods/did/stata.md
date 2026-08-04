# DiD — Stata 模板

## Setup

```stata
* 安装包
ssc install reghdfe, replace
ssc install ftools, replace
ssc install csdid, replace
ssc install drdid, replace
ssc install did_imputation, replace
ssc install event_plot, replace
ssc install estout, replace
```

## 1. 标准 TWFE（仅当处理时点同步时安全）

```stata
use "data/panel.dta", clear
xtset firm_id year

* D = 1 当处理 i 在 t 已经被处理
gen post = (year >= treat_year) if !missing(treat_year)
replace post = 0 if missing(treat_year)
gen did = treated * post

reghdfe lnY did $controls, absorb(firm_id year) cluster(province_id)
estimates store m_twfe

esttab m_twfe using "out/main.rtf", b(3) se(3) star(* 0.10 ** 0.05 *** 0.01) ///
    keep(did) replace
```

## 2. 事件研究图（处理时点为 g，事件时间 k = t - g）

```stata
gen event_t = year - treat_year
* 把超出窗口的极端值收尾，避免端点不可识别
replace event_t = -5 if event_t < -5 & !missing(treat_year)
replace event_t =  5 if event_t >  5

* 以 t-1 为基期（drop k = -1）
forvalues k = -5/5 {
    if `k' == -1 continue
    local kk = `k' + 100   // 避免负号
    gen ev`kk' = (event_t == `k') if !missing(treat_year)
    replace ev`kk' = 0 if missing(treat_year)
}
* 永远未处理组所有 ev* = 0

reghdfe lnY ev95 ev96 ev97 ev98 ev99 ev101 ev102 ev103 ev104 ev105 $controls, ///
    absorb(firm_id year) cluster(province_id)

event_plot, default_look stub_lag(ev10#) stub_lead(ev9#) ///
    graph_opt(title("Event study around policy") xtitle("Years from treatment"))
```

## 3. 交错处理：Callaway & Sant'Anna (csdid)

```stata
* csdid 要求 gvar 为首次处理年份，未处理设为 0
gen gvar = treat_year
replace gvar = 0 if missing(treat_year)

csdid lnY $controls, ivar(firm_id) time(year) gvar(gvar) ///
    method(dripw) agg(event)

estat event, window(-5 5) estore(cs_event)
event_plot cs_event, default_look ///
    graph_opt(title("CS Event study") xtitle("Event time"))

* 总 ATT
csdid_estat simple
```

## 4. 平行趋势 F 检验

```stata
* 在事件研究模型中检验所有 pre 期联合 = 0
test ev95 = ev96 = ev97 = ev98 = ev99 = 0
* p > 0.10 视为不拒绝平行趋势
```

## 5. 安慰剂（随机化处理时点）

```stata
preserve
local B = 500
tempname memhold
postfile `memhold' iter b_placebo se_placebo using "out/placebo.dta", replace

forvalues b = 1/`B' {
    cap drop fake_treat fake_post fake_did
    bys firm_id: gen rand = runiform() if _n == 1
    bys firm_id: replace rand = rand[1]
    gen fake_treat = (rand < 0.3)              // 30% 随机分配处理
    gen fake_year  = 2010 + int(runiform()*8)  // 随机时点
    gen fake_post  = (year >= fake_year)
    gen fake_did   = fake_treat * fake_post

    qui reghdfe lnY fake_did $controls, absorb(firm_id year) cluster(province_id)
    post `memhold' (`b') (_b[fake_did]) (_se[fake_did])
}
postclose `memhold'
restore
```

## 6. 输出解读 tips

- **did 系数**：单位与 lnY 一致，对数因变量 → 百分比解读 (`100*coef`)。
- **关注 pre-trend p 值**：希望 `>0.10`；< 0.05 基本意味着平行趋势不成立，慎报主回归。
- **聚类层级**：处理在省层 → cluster(province) 必做；样本 < 30 个 cluster 时用 wild bootstrap (`boottest`).
- **csdid vs TWFE 不一致**：若两者数值差异大、甚至符号反转 → 报告 csdid 为主、TWFE 仅作对照（说明负权重）。
