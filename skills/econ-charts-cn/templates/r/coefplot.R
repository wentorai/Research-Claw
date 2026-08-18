#!/usr/bin/env Rscript
# coefplot.R: replace toy data with your analysis output.
# coefplot.R —— 多回归系数横向对比图 (dotwhisker + ggplot2)
# install.packages(c("fixest", "dotwhisker", "ggplot2", "broom", "dplyr"))
# 运行: Rscript coefplot.R   ->  coefplot_out.pdf
# ----------------------------------------------------------------
# 用途: 同 stata/coefplot.do, 把 4 个模型的核心系数 + 95% CI
#       横向对比, 0 参考线虚线, 黑白可读.
# ----------------------------------------------------------------

suppressPackageStartupMessages({
  library(fixest)
  library(dotwhisker)
  library(ggplot2)
  library(broom)
  library(dplyr)
})

set.seed(20260501)

# ---- 1. 合成数据 ----
n <- 2000
df <- data.frame(
  id    = rep(1:200, each = 10),
  year  = rep(2010:2019, times = 200),
  ind   = sample(1:6, n, TRUE),
  x1    = rnorm(n),
  x2    = rnorm(n),
  ctrl1 = rnorm(n),
  ctrl2 = rnorm(n)
)
df$y <- 0.30 * df$x1 - 0.15 * df$x2 +
        0.20 * df$ctrl1 + 0.10 * df$ctrl2 +
        0.05 * df$year + rnorm(n)

# ---- 2. 四个模型 ----
m1 <- feols(y ~ x1 + x2,                                   data = df, vcov = "hetero")
m2 <- feols(y ~ x1 + x2 + ctrl1 + ctrl2,                   data = df, vcov = "hetero")
m3 <- feols(y ~ x1 + x2 + ctrl1 + ctrl2 | year,            data = df, cluster = ~id)
m4 <- feols(y ~ x1 + x2 + ctrl1 + ctrl2 | year + ind,      data = df, cluster = ~id)

# ---- 3. dotwhisker ----
models <- list(
  "(1) 基准"          = m1,
  "(2) +公司控制"     = m2,
  "(3) +年度 FE"      = m3,
  "(4) +年度+行业 FE" = m4
)

tidy_list <- lapply(names(models), function(nm) {
  td <- broom::tidy(models[[nm]], conf.int = TRUE, conf.level = 0.95)
  td$model <- nm
  td
})
td_all <- do.call(rbind, tidy_list)
td_all <- td_all[td_all$term %in% c("x1", "x2"), ]
td_all$term <- factor(td_all$term,
                      levels = c("x2", "x1"),
                      labels = c("辅助变量 X2", "核心解释变量 X1"))
td_all$model <- factor(td_all$model, levels = names(models))

p <- ggplot(td_all,
            aes(x = estimate, y = term, color = model, shape = model)) +
  geom_vline(xintercept = 0, linetype = "dashed", color = "gray40", linewidth = 0.4) +
  geom_errorbarh(aes(xmin = conf.low, xmax = conf.high),
                 position = position_dodge(width = 0.55),
                 height = 0, linewidth = 0.5) +
  geom_point(position = position_dodge(width = 0.55), size = 2.2) +
  scale_color_manual(values = c("#000000", "#595959", "#A6A6A6", "#404040")) +
  scale_shape_manual(values = c(16, 17, 15, 4)) +
  labs(x = "回归系数 (95% CI)", y = NULL, color = NULL, shape = NULL) +
  theme_classic(base_size = 9) +
  theme(legend.position = "bottom",
        legend.key.height = unit(0.3, "cm"),
        legend.text = element_text(size = 7),
        axis.title  = element_text(size = 9),
        axis.text   = element_text(size = 8),
        plot.margin = margin(4, 4, 4, 4))

ggsave("coefplot_out.pdf", p, width = 10, height = 6.5,
       units = "cm", device = cairo_pdf)
message("saved: coefplot_out.pdf")
