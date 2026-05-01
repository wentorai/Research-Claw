# IV — R 模板

## Setup

```r
# install.packages(c("AER", "ivreg", "fixest", "modelsummary", "ivDiag"))
library(AER)
library(ivreg)         # 改进版 ivreg
library(fixest)        # 高维 FE + IV
library(modelsummary)
```

## 1. 基础 2SLS — ivreg

```r
df <- read.csv("data/iv_sample.csv")

m_iv <- ivreg(
  Y ~ D + x1 + x2 | Z1 + Z2 + x1 + x2,
  data = df
)
summary(m_iv, diagnostics = TRUE)
# 输出含: Weak instruments, Wu-Hausman, Sargan(=Hansen J)
```

## 2. OLS vs 2SLS 对比

```r
m_ols <- lm(Y ~ D + x1 + x2, data = df)
modelsummary(
  list(OLS = m_ols, IV2SLS = m_iv),
  coef_map = c("D" = "D"),
  stars = TRUE
)
```

## 3. 高维 FE + IV — fixest

```r
m_fe <- feols(
  Y ~ x1 + x2 | firm_id + year | D ~ Z1 + Z2,
  data    = df,
  cluster = ~ province_id
)
summary(m_fe, stage = 1)   # 第一阶段
summary(m_fe)              # 第二阶段
# fixest 直接给 Kleibergen-Paap F 与 Wald
fitstat(m_fe, ~ ivf + ivwald)
```

## 4. Olea-Pflueger 有效 F + 全套诊断 — ivDiag

```r
# install.packages("ivDiag")
library(ivDiag)
out <- ivDiag(
  data  = df,
  Y     = "Y",
  D     = "D",
  Z     = c("Z1", "Z2"),
  controls = c("x1", "x2"),
  cl    = "province_id"        # cluster
)
out$F_effective    # Olea-Pflueger
out$AR             # Anderson-Rubin CI
out$tF             # tF-adjusted CI (Lee-McCrary-Moreira-Porter 2022)
plot(out)
```

## 5. 简化型 (Reduced Form)

```r
m_rf <- lm(Y ~ Z1 + Z2 + x1 + x2, data = df)
summary(m_rf)
# 看 Z1 / Z2 是否显著，且符号与第一阶段 × IV 系数符号一致
```

## 6. LIML / Fuller

```r
m_liml <- ivreg(Y ~ D + x1 + x2 | Z1 + Z2 + x1 + x2,
                data = df, method = "LIML")
summary(m_liml)

# Fuller-1
m_fuller <- ivreg(Y ~ D + x1 + x2 | Z1 + Z2 + x1 + x2,
                  data = df, method = "Fuller", k = 1)
```

## 7. Anderson-Rubin 弱-IV 稳健 CI

```r
# ivDiag 自带；或手算：
library(car)
linearHypothesis(m_iv, "D = 0", test = "F")   # 在零假设附近的 F
```

## 8. 安慰剂结果变量

```r
m_pl <- ivreg(Y_placebo ~ D + x1 + x2 | Z1 + Z2 + x1 + x2, data = df)
summary(m_pl)$coefficients["D", ]   # 应不显著
```

## 输出解读 tips

- `ivreg` 的 `summary(..., diagnostics = TRUE)` 同时给出：
  - **Weak instruments F**（每个内生变量一行）
  - **Wu-Hausman**：检验 OLS-vs-IV 差异（拒绝 = 内生性存在）
  - **Sargan / Hansen**：过度识别 J 检验
- **`fixest::fitstat(model, ~ ivf + ivwald)`** 输出 KP-F 和 Wald；建议在表底定型展示。
- **`ivDiag`**：现代审稿人友好，自动给 OP-F、AR、tF、加权 bootstrap CI；强烈推荐用于正式论文。
- **不要单看 t 值——弱 IV 时 t 不可信**；改用 AR 区间。
