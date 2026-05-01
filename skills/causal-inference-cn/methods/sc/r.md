# SC — R 模板

## Setup

```r
# install.packages(c("Synth", "gsynth", "synthdid", "augsynth", "ggplot2"))
library(Synth)
library(gsynth)        # 多处理单位 + 交错
# install.packages("synthdid", repos = "https://synth-inference.r-universe.dev")
library(synthdid)
library(augsynth)      # ASCM (Ben-Michael et al.)
library(ggplot2)
```

## 1. 基础 SCM — Synth 包

```r
# 数据为 long-format data.frame: region_id, year, lnGDP, ... 
df <- read.csv("data/region_panel.csv")

dataprep_out <- dataprep(
  foo = df,
  predictors = c("pop_density", "urb_rate",
                 "sec_industry_share", "fdi_share"),
  predictors.op = "mean",
  time.predictors.prior = 2003:2012,
  special.predictors = list(
    list("lnGDP", 2003, "mean"),
    list("lnGDP", 2007, "mean"),
    list("lnGDP", 2012, "mean")
  ),
  dependent = "lnGDP",
  unit.variable = "region_id",
  unit.names.variable = "region_name",
  time.variable = "year",
  treatment.identifier = 11,            # 北京
  controls.identifier = setdiff(unique(df$region_id), 11),
  time.optimize.ssr = 2003:2012,
  time.plot = 2003:2018
)

synth_out <- synth(dataprep_out)

# 主图：actual vs synthetic
path.plot(synth.res = synth_out, dataprep.res = dataprep_out,
          Ylab = "lnGDP", Xlab = "Year",
          Legend = c("Beijing", "Synthetic Beijing"))

# Gap 图
gaps.plot(synth.res = synth_out, dataprep.res = dataprep_out,
          Ylab = "Gap (lnGDP)", Xlab = "Year")

# 权重表
print(synth.tab(synth.res = synth_out, dataprep.res = dataprep_out)$tab.w)
```

## 2. In-space placebo 与 RMSPE p 值

```r
# 对每个控制单位都跑一遍 dataprep + synth，存 gap
controls <- setdiff(unique(df$region_id), 11)
all_gaps <- sapply(c(11, controls), function(u) {
  prep <- dataprep(
    foo = df,
    predictors = c("pop_density","urb_rate","sec_industry_share","fdi_share"),
    predictors.op = "mean",
    time.predictors.prior = 2003:2012,
    special.predictors = list(list("lnGDP", c(2003,2007,2012), "mean")),
    dependent = "lnGDP",
    unit.variable = "region_id",
    unit.names.variable = "region_name",
    time.variable = "year",
    treatment.identifier = u,
    controls.identifier = setdiff(c(11, controls), u),
    time.optimize.ssr = 2003:2012,
    time.plot = 2003:2018
  )
  s <- synth(prep)
  prep$Y1plot - prep$Y0plot %*% s$solution.w
})

# RMSPE 比例 = post / pre
rmspe_ratio <- apply(all_gaps, 2, function(g) {
  post <- mean(g[16:20]^2); pre <- mean(g[1:10]^2)
  sqrt(post / pre)
})
rank_treated <- which(order(-rmspe_ratio) == 1)
p_val <- rank_treated / length(rmspe_ratio)
cat("p-value (RMSPE ratio):", p_val, "\n")
```

## 3. Generalized SC (Xu 2017) — 多处理单位

```r
# data 含: region_id, year, lnGDP, treated (0/1), controls...
out_gsynth <- gsynth(
  lnGDP ~ treated + pop_density + urb_rate,
  data    = df,
  index   = c("region_id", "year"),
  force   = "two-way",
  CV      = TRUE, r = c(0, 5),       # 选择 factor 数
  se      = TRUE, inference = "parametric",
  nboots  = 1000, parallel = TRUE
)
plot(out_gsynth, type = "counterfactual")
plot(out_gsynth, type = "gap")
print(out_gsynth)
```

## 4. Synthetic DID

```r
setup <- panel.matrices(df, unit = "region_id", time = "year",
                        outcome = "lnGDP", treatment = "treated")
tau_hat <- synthdid_estimate(setup$Y, setup$N0, setup$T0)
print(summary(tau_hat))

# Placebo SE
se <- sqrt(vcov(tau_hat, method = "placebo"))
plot(tau_hat) + ggtitle("Synthetic DID")
```

## 5. Augmented SC (pre fit 不够好时)

```r
asc <- augsynth(
  form = lnGDP ~ treated,
  unit = region_id, time = year,
  data = df,
  progfunc = "Ridge",      # ridge augmentation
  scm     = TRUE
)
summary(asc)
plot(asc)
```

## 输出解读 tips

- **`synth.tab(...)$tab.w`** → 权重表；用 `xtable` 输出论文级 LaTeX。
- **`gsynth` 自动 CV 选 factor 数**：若 `r = 0` 即等价于双向固定效应。
- **`synthdid::summary()`** 含点估计、SE、CI；`plot()` 给主图。
- **augsynth 的 `progfunc`**：`"None"`=纯 SCM，`"Ridge"`=ASCM，`"GSYN"`=广义合成；高维场景一般 `"Ridge"`。
- 报告时主图来自 `Synth::path.plot`、稳健性来自 `synthdid` 与 `augsynth` 的对照点估计。
