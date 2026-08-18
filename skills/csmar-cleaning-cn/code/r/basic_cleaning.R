#===========================================================
# basic_cleaning.R
# CSMAR (国泰安) 数据清洗标准模板 - R 版
#
# 流程:
#   1) 合成 minimal CSMAR 数据 (用于自检)
#   2) 样本筛选: 剔金融 / 剔 ST / 剔 IPO 当年 / 剔 B 股
#   3) 关键变量缺失值删除
#   4) 极值缩尾 (DescTools::Winsorize, 1%/99%)
#   5) 输出干净面板
#
# 依赖:
#   install.packages(c("dplyr", "DescTools"))
#===========================================================

suppressPackageStartupMessages({
  library(dplyr)
  library(DescTools)
})

set.seed(20260501)

#-----------------------------------------------------------
# Step 0: 合成 minimal 数据
#-----------------------------------------------------------
n <- 200
df <- tibble::tibble(
  Stkcd  = sprintf("%06d", ((seq_len(n) - 1) %% 20) + 1),
  year   = 2010 + ((seq_len(n) - 1) %/% 20) %% 10,
  IndCd  = ifelse(seq_len(n) %% 30 == 0, "J66",
            ifelse(seq_len(n) %% 40 == 0, "K70",
              ifelse(seq_len(n) %% 7  == 0, "C26", "C39"))),
  Trdsta = ifelse(seq_len(n) %% 50 == 0, 2L, 1L),
  ListDt = as.Date(sprintf("%d-01-01", 2009 + (seq_len(n) %% 5))),
  roa    = rnorm(n, 0.05, 0.08),
  lev    = runif(n, 0.1, 0.7),
  size   = rnorm(n, 22, 1.5),
  growth = rnorm(n, 0.15, 0.30)
)

# 注入 B 股 / 极端值 / 缺失
df$Stkcd[seq(1, n, by = 20)] <- paste0("9", substr(df$Stkcd[seq(1, n, by = 20)], 2, 6))
df$roa[seq(1, n, by = 100)]  <- 5.0
df$roa[seq(1, n, by = 99)]   <- -3.0
df$roa[seq(1, n, by = 60)]   <- NA_real_

cat("=== 原始数据 ===\n")
print(summary(df[, c("roa", "lev", "size", "growth")]))
cat("\nIndCd 分布:\n")
print(table(df$IndCd, useNA = "ifany"))
cat("\nTrdsta 分布:\n")
print(table(df$Trdsta, useNA = "ifany"))

#-----------------------------------------------------------
# Step 1: 样本期窗口
#-----------------------------------------------------------
df <- df %>% filter(year >= 2010, year <= 2019)

#-----------------------------------------------------------
# Step 2: 剔除金融业 (CSRC 2001 = I, CSRC 2012 = J)
#-----------------------------------------------------------
df <- df %>% filter(!substr(IndCd, 1, 1) %in% c("I", "J"))

# (可选) 剔房地产
# df <- df %>% filter(substr(IndCd, 1, 1) != "K")

#-----------------------------------------------------------
# Step 3: 剔除 ST / *ST / PT
#-----------------------------------------------------------
df <- df %>% filter(Trdsta == 1)

#-----------------------------------------------------------
# Step 4: 剔除 IPO 当年观测
#-----------------------------------------------------------
df <- df %>%
  mutate(years_listed = year - as.integer(format(ListDt, "%Y"))) %>%
  filter(years_listed >= 1) %>%
  select(-years_listed)

#-----------------------------------------------------------
# Step 5: 剔除 B 股
#-----------------------------------------------------------
df <- df %>%
  filter(!substr(Stkcd, 1, 1) %in% c("9")) %>%
  filter(!substr(Stkcd, 1, 2) %in% c("20"))

#-----------------------------------------------------------
# Step 6: 关键变量缺失值
#-----------------------------------------------------------
df <- df %>%
  filter(!is.na(roa), !is.na(lev), !is.na(size), !is.na(growth))

#-----------------------------------------------------------
# Step 7: 极值缩尾 (1% / 99%)
# 注意: DescTools::Winsorize 默认 5% / 95%, 必须显式 probs = c(0.01, 0.99)
#-----------------------------------------------------------
winsor_vars <- c("roa", "lev", "size", "growth")

df_clean <- df %>%
  mutate(across(all_of(winsor_vars),
                ~ Winsorize(.x, probs = c(0.01, 0.99), na.rm = TRUE)))

#-----------------------------------------------------------
# Step 8: 描述性统计 + 面板结构
#-----------------------------------------------------------
cat("\n=== 清洗后样本 ===\n")
print(summary(df_clean[, winsor_vars]))

panel_summary <- df_clean %>%
  group_by(Stkcd) %>%
  summarise(n_years = n(), .groups = "drop") %>%
  count(n_years, name = "n_firms")

cat("\n=== 面板结构 (每家公司观测年数分布) ===\n")
print(panel_summary)

cat(sprintf("\n清洗后样本量: %d 观测 / %d 公司 / %d 年\n",
            nrow(df_clean),
            length(unique(df_clean$Stkcd)),
            length(unique(df_clean$year))))

#-----------------------------------------------------------
# Step 9: 保存
#-----------------------------------------------------------
# saveRDS(df_clean, "clean_panel.rds")
# arrow::write_parquet(df_clean, "clean_panel.parquet")

cat("\n=== Clean panel ready. ===\n")
