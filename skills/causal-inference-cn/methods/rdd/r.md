# RDD — R 模板

## Setup

```r
# install.packages(c("rdrobust", "rddensity", "rdpower", "ggplot2"))
library(rdrobust)
library(rddensity)
library(ggplot2)
```

## 1. RDD 散点图

```r
df <- read.csv("data/rdd_sample.csv")
# X 已中心化为 X - cutoff，cutoff = 0

rdplot(
  y = df$Y, x = df$X, c = 0, p = 1,
  title = "RD plot, p=1",
  x.label = "Score - cutoff",
  y.label = "Y",
  binselect = "esmv"   # equally spaced + min variance
)
```

## 2. Sharp RDD 主估计

```r
res <- rdrobust(
  y = df$Y, x = df$X,
  c = 0, p = 1,
  kernel = "triangular",
  bwselect = "mserd"
)
summary(res)

# 关键字段
res$coef          # 三套点估计：Conventional / Bias-Corrected / Robust
res$ci            # 三套 CI
res$bws           # 选出的带宽 h, b
res$N_h           # 带宽内样本量
```

## 3. Fuzzy RDD

```r
res_fz <- rdrobust(
  y = df$Y, x = df$X, fuzzy = df$D,
  c = 0, p = 1, kernel = "triangular", bwselect = "mserd"
)
summary(res_fz)
```

## 4. McCrary 密度检验

```r
mc <- rddensity(X = df$X, c = 0)
summary(mc)            # 关注 T 统计量与 p 值
rdplotdensity(mc, X = df$X)
```

## 5. 协变量平衡

```r
covars <- c("age", "female", "edu")
balance <- lapply(covars, function(v) {
  r <- rdrobust(y = df[[v]], x = df$X, c = 0, p = 1, bwselect = "mserd")
  c(var = v,
    tau   = r$coef["Conventional", 1],
    p_rb  = r$pv  ["Robust",       1],
    h     = r$bws ["h",            1])
})
do.call(rbind, balance)
```

## 6. 带宽稳健性扫描

```r
mults <- c(0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0)
h0 <- res$bws["h", 1]
sweep <- t(sapply(mults, function(m) {
  r <- rdrobust(df$Y, df$X, c = 0, p = 1, h = m * h0, kernel = "triangular")
  c(mult = m, tau = r$coef[1, 1], se = r$se[1, 1], N = r$N_h[1] + r$N_h[2])
}))
print(sweep, digits = 3)

ggplot(data.frame(sweep), aes(x = mult, y = tau)) +
  geom_point() + geom_line() +
  geom_hline(yintercept = 0, linetype = 2) +
  labs(x = "h multiplier", y = "tau", title = "Bandwidth sensitivity")
```

## 7. 多项式阶数

```r
for (p in 1:3) {
  cat("=== p =", p, "===\n")
  print(summary(rdrobust(df$Y, df$X, c = 0, p = p, bwselect = "mserd")))
}
```

## 8. Donut hole

```r
for (eps in c(0.02, 0.05, 0.10)) {
  keep <- abs(df$X) > eps
  r <- rdrobust(df$Y[keep], df$X[keep], c = 0, p = 1, bwselect = "mserd")
  cat(sprintf("eps = %.2f : tau = %.3f, robust p = %.3f\n",
              eps, r$coef[1, 1], r$pv[3, 1]))
}
```

## 输出解读 tips

- 三行系数：**Conventional** 用于直觉；**Robust** 用于报告显著性；**Bias-Corrected** 仅作对照。
- **MSE-optimal `h`** 与 **bias bandwidth `b`**：CCT 推荐 `b > h` 的设置由 `bwselect="mserd"` 自动给出。
- 协变量平衡：**所有协变量的 robust p 都 > 0.10** 是基本要求，否则连续性受质疑。
- `ggdid` 这种事件研究的图在 RDD 中等价于 **"系数 vs 带宽" 折线图**（item 6），是审稿人最爱的稳健性图。
