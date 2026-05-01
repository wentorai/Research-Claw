# SC — Stata 模板

## Setup

```stata
* 安装包
ssc install synth, replace
ssc install synth_runner, replace      // placebo 自动批量
ssc install sdid, replace              // Synthetic DID (Arkhangelsky 2021)
ssc install scul, replace              // 罚化 / 高维控制池
ssc install distinct, replace
```

## 1. 准备面板

```stata
use "data/region_panel.dta", clear
* 必须 strongly balanced：每个 unit 在每个 year 都有观测
xtset region_id year

* 标记处理单位 (e.g., 北京 = 11)
local treat_unit  = 11
local treat_year  = 2013
```

## 2. 基础 SCM (Abadie-Diamond-Hainmueller)

```stata
synth lnGDP ///
    lnGDP(2003) lnGDP(2005) lnGDP(2007) lnGDP(2010) lnGDP(2012) ///
    pop_density urb_rate sec_industry_share fdi_share, ///
    trunit(`treat_unit') trperiod(`treat_year') ///
    xperiod(2003(1)2012) mspeperiod(2003(1)2012) ///
    fig keep("out/synth_main.dta", replace)

* synth 输出：
* - W weights（哪些控制单位，每个权重）
* - V weights（每个预测变量重要性）
* - Pre-RMSPE / Post-RMSPE
* - 自动画 actual vs synthetic 图
```

## 3. In-space placebo（spaghetti 图） — synth_runner

```stata
synth_runner lnGDP ///
    lnGDP(2003) lnGDP(2005) lnGDP(2007) lnGDP(2010) lnGDP(2012) ///
    pop_density urb_rate sec_industry_share fdi_share, ///
    trunit(`treat_unit') trperiod(`treat_year') ///
    gen_vars

* 画图：每个 unit 的 gap 都画上去
single_treatment_graphs, ///
    treated_name("Beijing") effects_ylabels(-0.2(0.05)0.2) ///
    raw_options(ytitle("lnGDP")) effects_options(ytitle("Gap (lnGDP)"))

* 报告 p-value：基于 post/pre RMSPE 比例的排名 p
display "Two-sided p-value (RMSPE ratio): " e(pval_joint_post)
```

## 4. Leave-one-out 稳健性

```stata
* 找出主结果中权重 > 0.05 的控制单位，逐个剔除
levelsof region_id if region_id != `treat_unit', local(controls)
foreach c of local controls {
    qui synth lnGDP ///
        lnGDP(2003) lnGDP(2005) lnGDP(2007) lnGDP(2010) lnGDP(2012) ///
        pop_density urb_rate sec_industry_share fdi_share ///
        if region_id != `c', ///
        trunit(`treat_unit') trperiod(`treat_year') ///
        xperiod(2003(1)2012) mspeperiod(2003(1)2012)
    di "Drop " `c' " : Post-RMSPE = " e(post_RMSPE)
}
```

## 5. Synthetic DID（多处理单位 / 交错）

```stata
sdid lnGDP region_id year treated, ///
    method(sdid) vce(placebo) seed(42) reps(500) graph
* method(sc) 即纯 SCM, method(did) 即 DID, method(sdid) 即合成 DID
* vce(placebo) 用 placebo permutation 推断
```

## 6. SCUL（罚化合成控制 / 高维控制池）

```stata
scul lnGDP, ///
    treated(`treat_unit') trperiod(`treat_year') ///
    cv_block_size(2) lassocv penalized
* 适合控制池单位 > 20 时；自动 LASSO + 交叉验证
```

## 输出解读 tips

- **Pre-RMSPE**：越小越好。经验法则：Pre-RMSPE / 处理前 Y 的 SD < 0.1 → 拟合好。
- **W 权重**：若集中在 1-2 个单位 → 本质退化为 DID；若 30 个单位都有微小权重 → 控制池没有信息，结果脆弱。
- **Post-RMSPE / Pre-RMSPE 比**：synth_runner 的核心 p 值依据；真实单位排在 placebo 分布前 5% 才显著。
- **重要陷阱**：`xperiod()` 和 `mspeperiod()` 的窗口要谨慎；`mspeperiod` 只在该窗口内最小化拟合误差。
- 报告时同时给：(a) actual vs synthetic 图，(b) gap 图带 placebo 通道，(c) 权重表。
