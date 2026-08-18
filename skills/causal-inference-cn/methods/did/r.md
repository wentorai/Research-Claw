# DiD — R 模板

## Setup

```r
# install.packages(c("fixest", "did", "data.table", "ggplot2", "broom"))
library(fixest)    # 高维 FE + 事件研究
library(did)       # Callaway & Sant'Anna
library(data.table)
library(ggplot2)
```

## 1. 标准 TWFE（仅当处理时点同步时安全）

```r
dt <- fread("data/panel.csv")
dt[, post := as.integer(year >= treat_year)]
dt[is.na(treat_year), post := 0L]
dt[, did := treated * post]

m_twfe <- feols(
  lnY ~ did + x1 + x2 | firm_id + year,
  data    = dt,
  cluster = ~ province_id
)
summary(m_twfe)
etable(m_twfe, keep = "did")
```

## 2. 事件研究 (fixest)

`fixest::i()` 自动生成事件指示并支持 `ref =` 设置基期。

```r
dt[, event_t := year - treat_year]
dt[is.na(treat_year), event_t := NA_integer_]      # 未处理组
dt[event_t < -5, event_t := -5]
dt[event_t >  5, event_t :=  5]

m_event <- feols(
  lnY ~ i(event_t, ref = -1) + x1 + x2 | firm_id + year,
  data    = dt,
  cluster = ~ province_id
)
iplot(m_event, main = "Event study", xlab = "Years from treatment")
```

## 3. 交错处理：Callaway & Sant'Anna (did 包)

```r
# treat_year = NA → 未处理
dt[, gvar := fifelse(is.na(treat_year), 0L, as.integer(treat_year))]

cs <- att_gt(
  yname   = "lnY",
  tname   = "year",
  idname  = "firm_id",
  gname   = "gvar",
  xformla = ~ x1 + x2,
  data    = dt,
  control_group = "notyettreated",
  est_method    = "dr",          # doubly robust
  clustervars   = "province_id"
)

# 聚合到事件时间
cs_event <- aggte(cs, type = "dynamic", min_e = -5, max_e = 5)
ggdid(cs_event)

# 总 ATT
cs_simple <- aggte(cs, type = "simple")
summary(cs_simple)
```

## 4. 平行趋势检验

```r
# fixest 事件研究下，检验 pre 期联合 = 0
wald(m_event, keep = "event_t::-")
# H0: 所有 pre 期 == 0 ; p > 0.10 视为通过
```

## 5. 安慰剂（随机化处理时点）

```r
set.seed(42)
B <- 500
unit_ids <- unique(dt$firm_id)
years    <- 2005:2018

placebo <- replicate(B, {
  fake_treat <- sample(unit_ids, size = round(0.3 * length(unit_ids)))
  fake_year  <- sample(years, size = length(fake_treat), replace = TRUE)
  fake_map   <- data.table(firm_id = fake_treat, fake_year = fake_year)
  d2 <- merge(dt, fake_map, by = "firm_id", all.x = TRUE)
  d2[, fake_post := as.integer(year >= fake_year)]
  d2[is.na(fake_post), fake_post := 0L]
  d2[, fake_did := as.integer(!is.na(fake_year)) * fake_post]
  coef(feols(lnY ~ fake_did | firm_id + year, data = d2))[["fake_did"]]
})

quantile(placebo, c(.025, .975))
hist(placebo)
abline(v = coef(m_twfe)[["did"]], col = "red", lwd = 2)
```

## 6. 输出解读 tips

- `etable()` / `modelsummary()` → 论文级回归表。
- **iplot 横轴**：事件时间。基期 `-1` 系数恒为 0；图上虚线 95% CI。
- **`did::aggte` 的几种汇总**：
  - `type = "simple"` → 总 ATT
  - `type = "dynamic"` → 事件时间 (推荐主图)
  - `type = "group"` → 按 g 看异质性
  - `type = "calendar"` → 按 t 看
- **`control_group`**：`"notyettreated"` 比 `"nevertreated"` 更利用对照信息，但需要数据中存在尚未处理观测。
