#!/usr/bin/env Rscript
# bin_scatter.R: replace toy data with your analysis output.
# bin_scatter.R —— Bin scatter (Cattaneo et al. binsreg)
# install.packages(c("binsreg", "ggplot2"))
# 运行: Rscript bin_scatter.R   ->  bin_scatter_out.pdf
# ----------------------------------------------------------------
# 用途: 大样本 (n=20k) 散点 + 二阶多项式拟合 + 95% CI 阴影带.
#       binsreg 默认用 IMSE 最优分箱数.
# ----------------------------------------------------------------

suppressPackageStartupMessages({
  library(binsreg)
  library(ggplot2)
})

set.seed(20260501)

# ---- 1. 合成大样本 ----
n <- 20000
x      <- rnorm(n, sd = 1.5)
ctrl1  <- rnorm(n)
ctrl2  <- rnorm(n)
y <- 0.4 * x + 0.15 * x^2 + 0.20 * ctrl1 - 0.10 * ctrl2 + rnorm(n, sd = 1.2)
df <- data.frame(y = y, x = x, ctrl1 = ctrl1, ctrl2 = ctrl2)

# ---- 2. binsreg ----
fit <- binsreg(y = df$y, x = df$x,
               w = df[, c("ctrl1", "ctrl2")],
               nbins = 25, polyreg = 2, cb = c(2, 2),
               plotxrange = c(-3, 3),
               noplot = TRUE)

# ---- 3. 取 binsreg 输出, 用 ggplot2 重画 ----
dots <- fit$data.plot$`Group Full Sample`$data.dots
poly <- fit$data.plot$`Group Full Sample`$data.poly
cb   <- fit$data.plot$`Group Full Sample`$data.cb

p <- ggplot() +
  geom_ribbon(data = cb,
              aes(x = x, ymin = cb.l, ymax = cb.r),
              fill = "gray80", alpha = 0.6) +
  geom_line(data = poly, aes(x = x, y = fit),
            color = "black", linewidth = 0.6) +
  geom_point(data = dots, aes(x = x, y = fit),
             color = "black", fill = "black",
             shape = 21, size = 1.6) +
  labs(x = "X (标准化)",
       y = "Y",
       caption = "注: 25 箱, 二阶多项式拟合 + 95% 置信带; 控制 ctrl1, ctrl2.") +
  theme_classic(base_size = 9) +
  theme(plot.caption = element_text(size = 7, hjust = 0))

ggsave("bin_scatter_out.pdf", p, width = 10, height = 6.5,
       units = "cm", device = cairo_pdf)
message("saved: bin_scatter_out.pdf")
