#!/usr/bin/env Rscript
# event_study.R: replace toy data with your analysis output.
# event_study.R —— DiD 事件研究图 (fixest::feols + iplot)
# install.packages(c("fixest", "ggplot2", "dplyr", "broom"))
# 运行: Rscript event_study.R   ->  event_study_out.pdf
# ----------------------------------------------------------------
# 用途: staggered DiD, 用 fixest 的 i() 自动构建 lead/lag dummies,
#       基期 t = -1 归零, 报告 95% CI, 处理时点画垂直虚线.
# ----------------------------------------------------------------

suppressPackageStartupMessages({
  library(fixest)
  library(ggplot2)
  library(dplyr)
})

set.seed(20260501)

# ---- 1. 合成 staggered DiD 面板 ----
n_unit  <- 200
n_year  <- 20
year_lo <- 2010
df <- expand.grid(id = 1:n_unit, year = seq(year_lo, year_lo + n_year - 1))
treat_units <- 1:(n_unit / 2)
df$treat_year <- ifelse(df$id %in% treat_units,
                        2017 + df$id %% 5,
                        NA_integer_)
df$rel <- df$year - df$treat_year
df$post <- as.integer(!is.na(df$rel) & df$rel >= 0)
df$y <- 0.5 * df$post * (1 + 0.3 * pmax(df$rel, 0)) +
        0.05 * df$year + rnorm(nrow(df))
df$rel_eff <- ifelse(is.na(df$rel), -100, df$rel)

# ---- 2. fixest event study ----
es <- feols(y ~ i(rel_eff, ref = c(-1, -100)) | id + year,
            data = df, cluster = ~id)

# ---- 3. 抽参数 + 自定义 ggplot ----
es_tab <- broom::tidy(es, conf.int = TRUE, conf.level = 0.95)
es_tab$lag <- as.integer(sub("rel_eff::", "", es_tab$term))
es_tab <- subset(es_tab, lag >= -4 & lag <= 5)

base_row <- data.frame(term = "rel_eff::-1", estimate = 0,
                       std.error = 0, statistic = 0, p.value = 1,
                       conf.low = 0, conf.high = 0, lag = -1)
es_tab <- rbind(es_tab, base_row[, names(es_tab)])
es_tab <- es_tab[order(es_tab$lag), ]
es_tab$is_base <- es_tab$lag == -1

p <- ggplot(es_tab, aes(x = lag, y = estimate)) +
  geom_hline(yintercept = 0,    linetype = "dashed", color = "gray40", linewidth = 0.4) +
  geom_vline(xintercept = -0.5, linetype = "dotted", color = "gray40", linewidth = 0.4) +
  geom_errorbar(aes(ymin = conf.low, ymax = conf.high),
                width = 0.15, linewidth = 0.5, color = "black") +
  geom_point(aes(shape = is_base, fill = is_base), size = 2.2, color = "black") +
  scale_shape_manual(values = c(`FALSE` = 21, `TRUE` = 21), guide = "none") +
  scale_fill_manual(values = c(`FALSE` = "black", `TRUE` = "white"), guide = "none") +
  scale_x_continuous(breaks = -4:5) +
  labs(x = "距政策实施年份 (年)",
       y = "处理效应估计 (95% CI)") +
  theme_classic(base_size = 9) +
  theme(axis.title = element_text(size = 9),
        axis.text  = element_text(size = 8))

ggsave("event_study_out.pdf", p, width = 10, height = 6.5,
       units = "cm", device = cairo_pdf)
message("saved: event_study_out.pdf")
