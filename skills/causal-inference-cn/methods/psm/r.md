# PSM — R 模板

## Setup

```r
# install.packages(c("MatchIt", "cobalt", "WeightIt", "sensitivitymw",
#                    "rbounds", "marginaleffects", "ggplot2"))
library(MatchIt)
library(cobalt)               # balance diagnostics & love-plots
library(WeightIt)             # IPW / entropy balancing
library(marginaleffects)      # 估 ATT/ATE
```

## 1. 倾向分估计 + 1:1 最近邻匹配

```r
df <- read.csv("data/firm_2014.csv")  # 截面

m_nn1 <- matchit(
  D ~ lnAsset + leverage + roa + age + tobinq + factor(industry),
  data    = df,
  method  = "nearest",
  distance = "glm",            # logit
  link     = "logit",
  caliper  = 0.05,
  ratio    = 1,
  replace  = FALSE
)
summary(m_nn1)                 # 含平衡表
matched <- match.data(m_nn1)
```

## 2. 平衡诊断 — cobalt

```r
# 标准化均值差 (SMD)，匹配前后对比
bal.tab(m_nn1, un = TRUE, m.threshold = 0.1)

# Love plot：审稿人最爱的图
love.plot(m_nn1, threshold = 0.1, abs = TRUE,
          var.order = "unadjusted")

# 倾向分密度图
bal.plot(m_nn1, var.name = "distance",
         which = "both",       # before & after
         type = "density")
```

## 3. ATT 估计

```r
# 对匹配样本回归 Y on D + 协变量（双重稳健）
fit <- lm(Y ~ D + lnAsset + leverage + roa + age + tobinq,
          data = matched, weights = weights)
avg_comparisons(fit, variables = "D",
                vcov = "HC3", newdata = subset(matched, D == 1))
# 输出 ATT 点估计 + CI
```

## 4. 多种稳健性匹配

```r
# 1:4 最近邻
m_nn4 <- matchit(D ~ lnAsset + leverage + roa + age + tobinq + factor(industry),
                 data = df, method = "nearest", ratio = 4, caliper = 0.05)

# Mahalanobis
m_mh <- matchit(D ~ lnAsset + leverage + roa + age + tobinq + factor(industry),
                data = df, method = "nearest", distance = "mahalanobis")

# Full matching
m_full <- matchit(D ~ lnAsset + leverage + roa + age + tobinq + factor(industry),
                  data = df, method = "full")

# Coarsened exact matching
m_cem <- matchit(D ~ lnAsset + leverage + roa + age + tobinq,
                 data = df, method = "cem")

# Genetic matching
m_gen <- matchit(D ~ lnAsset + leverage + roa + age + tobinq,
                 data = df, method = "genetic")
```

## 5. Entropy balancing — WeightIt

```r
w <- weightit(
  D ~ lnAsset + leverage + roa + age + tobinq + factor(industry),
  data   = df,
  method = "ebal",
  estimand = "ATT"
)
bal.tab(w, m.threshold = 0.05)

fit_ebal <- lm(Y ~ D, data = df, weights = w$weights)
summary(fit_ebal)
```

## 6. IPW & Doubly Robust (AIPW)

```r
# IPW
w_ipw <- weightit(
  D ~ lnAsset + leverage + roa + age + tobinq + factor(industry),
  data   = df,
  method = "glm", estimand = "ATT", link = "logit"
)
fit_ipw <- lm(Y ~ D, data = df, weights = w_ipw$weights)

# AIPW via DoubleML
# install.packages("DoubleML"); install.packages("mlr3learners")
library(DoubleML); library(mlr3learners)
dml_data <- DoubleMLData$new(df,
  y_col = "Y", d_cols = "D",
  x_cols = c("lnAsset","leverage","roa","age","tobinq"))

learner_g <- lrn("regr.ranger")
learner_m <- lrn("classif.ranger")
dml_irm <- DoubleMLIRM$new(dml_data,
  ml_g = learner_g$clone(), ml_m = learner_m$clone(),
  score = "ATTE", n_folds = 5)
dml_irm$fit()
dml_irm$summary()
```

## 7. PSM-DID

```r
# Step 1: 在 t-1 期截面做 PSM，提取配对 ID
df_pre <- subset(df_panel, year == 2014)
m <- matchit(D ~ lnAsset + leverage + roa + age + tobinq,
             data = df_pre, method = "nearest", caliper = 0.05)
matched_ids <- match.data(m)$id

# Step 2: 在面板上跑 DID
panel_m <- subset(df_panel, id %in% matched_ids)
panel_m$post <- as.integer(panel_m$year >= 2015)
panel_m$did  <- panel_m$D * panel_m$post

library(fixest)
feols(Y ~ did + lnAsset + leverage | id + year,
      data = panel_m, cluster = ~ industry)
```

## 8. Rosenbaum bounds — sensitivity

```r
# install.packages("rbounds")
library(rbounds)

# 基于配对差，需要先 1:1 匹配
m1 <- matchit(D ~ lnAsset + leverage + roa + age + tobinq,
              data = df, method = "nearest", ratio = 1, replace = FALSE)
md1 <- match.data(m1)
treated <- md1$Y[md1$D == 1]
control <- md1$Y[md1$D == 0]

# 必须 1:1，且按 subclass 配对
psens(treated, control, Gamma = 2, GammaInc = 0.1)
# 报告 Gamma 临界值（结果开始不显著时的混淆强度）
```

## 输出解读 tips

- `cobalt::love.plot` 必出图，配合 SMD 阈值 `0.1`。
- **匹配后样本量**：`summary(m_nn1)` 给出 matched / unmatched / discarded 计数；丢弃过多 (> 40%) 说明 overlap 不足。
- **多种匹配方法 ATT 应大致一致**——若 entropy balancing 与 PSM 系数差距 > 30%，需要检查倾向分模型是否设错。
- **DoubleML 是现代主流**：用机器学习估 nuisance + cross-fitting，回应 King-Nielsen 批评的最佳工具。
- 表格三列：(1) Naive OLS, (2) PSM (NN1+caliper), (3) DR / DML。
