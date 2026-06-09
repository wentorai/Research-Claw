#!/usr/bin/env Rscript
# forest_plot.R: replace toy data with your analysis output.
# forest_plot.R —— 元分析森林图 (forestplot 包)
# install.packages(c("forestplot", "metafor"))
# 运行: Rscript forest_plot.R   ->  forest_plot_out.pdf
# ----------------------------------------------------------------
# 用途: 综述类文章汇总 12 个研究的效应量 (OR / Beta), 每行一个研究,
#       底部加 random-effect 汇总 diamond, 报告 I^2 异质性.
# ----------------------------------------------------------------

suppressPackageStartupMessages({
  library(forestplot)
  library(metafor)
})

set.seed(20260501)

# ---- 1. 合成 12 个研究的效应量 (OR scale) ----
studies <- paste0("Study ", LETTERS[1:12], " (", sample(2010:2024, 12), ")")
true_logOR <- rnorm(12, mean = 0.30, sd = 0.20)
se         <- runif(12, 0.08, 0.25)
yi         <- true_logOR + rnorm(12, sd = se)
vi         <- se^2

# ---- 2. metafor 元分析 ----
res <- rma(yi = yi, vi = vi, method = "REML")
summary_logOR <- as.numeric(coef(res))
summary_lo    <- res$ci.lb
summary_hi    <- res$ci.ub
i2 <- round(res$I2, 1)
tau2 <- round(res$tau2, 3)

# ---- 3. 转 OR ----
mean_OR <- exp(c(yi, summary_logOR))
lo_OR   <- exp(c(yi - 1.96 * se, summary_lo))
hi_OR   <- exp(c(yi + 1.96 * se, summary_hi))

labels <- rbind(
  c("研究",      "OR",            "95% CI",                       "权重"),
  cbind(studies,
        sprintf("%.2f", exp(yi)),
        sprintf("[%.2f, %.2f]", exp(yi - 1.96 * se), exp(yi + 1.96 * se)),
        sprintf("%.1f%%", 100 * (1/vi) / sum(1/vi))),
  c("汇总 (REML)",
    sprintf("%.2f", exp(summary_logOR)),
    sprintf("[%.2f, %.2f]", exp(summary_lo), exp(summary_hi)),
    "100%")
)

m  <- c(NA, mean_OR)
lo <- c(NA, lo_OR)
hi <- c(NA, hi_OR)
is_summary <- c(TRUE, rep(FALSE, 12), TRUE)

# ---- 4. 绘图 ----
pdf("forest_plot_out.pdf", width = 6.5, height = 4.5)
forestplot(labeltext = labels,
           mean      = m,
           lower     = lo,
           upper     = hi,
           is.summary = is_summary,
           xlog      = TRUE,
           xlab      = sprintf("OR (95%% CI)   |   I^2 = %s%%, tau^2 = %s", i2, tau2),
           col       = fpColors(box = "black", line = "black",
                                summary = "black", zero = "gray40"),
           txt_gp    = fpTxtGp(label = gpar(cex = 0.7),
                               ticks = gpar(cex = 0.6),
                               xlab  = gpar(cex = 0.7)),
           boxsize   = 0.15,
           lineheight = unit(0.5, "cm"),
           graph.pos = 2,
           zero      = 1,
           grid      = TRUE)
dev.off()
message("saved: forest_plot_out.pdf")
