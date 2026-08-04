#!/usr/bin/env Rscript
# marginal_effects.R: replace toy data with your analysis output.
# marginal_effects.R —— 交互项边际效应图 (marginaleffects + ggplot2)
# install.packages(c("ggplot2", "marginaleffects"))
# 运行: Rscript marginal_effects.R   ->  marginal_effects_out.pdf
# ----------------------------------------------------------------
# 用途: 估计 Y = b1*X + b2*X*Z + b3*Z + ctrl, 画 dY/dX 在 Z
#       不同取值下的边际效应 + 95% CI 阴影带 + Z 的 rug.
# ----------------------------------------------------------------

suppressPackageStartupMessages({
  library(ggplot2)
  library(marginaleffects)
})

set.seed(20260501)

# ---- 1. 合成数据 ----
n <- 3000
x    <- rnorm(n)
z    <- rnorm(n)
ctrl <- rnorm(n)
y    <- 0.30 * x + 0.20 * x * z + 0.10 * z + 0.15 * ctrl + rnorm(n)
df   <- data.frame(y = y, x = x, z = z, ctrl = ctrl)

# ---- 2. 估计 ----
fit <- lm(y ~ x * z + ctrl, data = df)

# ---- 3. 边际效应在 Z 的 5%-95% 分位区间 ----
z_lo <- quantile(df$z, 0.05)
z_hi <- quantile(df$z, 0.95)
z_grid <- seq(z_lo, z_hi, length.out = 50)

me <- slopes(fit, variables = "x",
             newdata = datagrid(z = z_grid, ctrl = mean(df$ctrl)))

me_df <- data.frame(z = me$z,
                    estimate = me$estimate,
                    conf.low = me$conf.low,
                    conf.high = me$conf.high)

# ---- 4. 绘图 ----
p <- ggplot(me_df, aes(x = z, y = estimate)) +
  geom_hline(yintercept = 0, linetype = "dashed",
             color = "gray40", linewidth = 0.4) +
  geom_ribbon(aes(ymin = conf.low, ymax = conf.high),
              fill = "gray80", alpha = 0.6) +
  geom_line(color = "black", linewidth = 0.6) +
  geom_rug(data = df, aes(x = z), inherit.aes = FALSE,
           sides = "b", alpha = 0.15, length = unit(0.025, "npc")) +
  labs(x = "调节变量 Z",
       y = expression("X 对 Y 的边际效应 " * dY/dX),
       caption = "注: 阴影为 95% CI; rug 显示 Z 的边际分布; 控制变量 ctrl.") +
  theme_classic(base_size = 9) +
  theme(plot.caption = element_text(size = 7, hjust = 0))

ggsave("marginal_effects_out.pdf", p, width = 10, height = 6.5,
       units = "cm", device = cairo_pdf)
message("saved: marginal_effects_out.pdf")
