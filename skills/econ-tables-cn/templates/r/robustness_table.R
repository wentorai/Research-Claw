# R table template: robustness_table.R for econ-tables-cn
# Replace toy data with your cleaned research dataset.
set.seed(1)
df <- data.frame(
  firm_id = rep(1:20, each = 5),
  year = rep(2000:2004, times = 20),
  y = rnorm(100),
  x = rnorm(100),
  control = rnorm(100)
)
# Recommended packages in real projects:
# install.packages(c("fixest", "modelsummary"))
if (requireNamespace("fixest", quietly = TRUE)) {
  m1 <- fixest::feols(y ~ x + control | year, data = df, cluster = ~ firm_id)
  print(summary(m1))
} else {
  m1 <- lm(y ~ x + control + factor(year), data = df)
  print(summary(m1))
}
# Quality gates:
# - Define SE type.
# - Label fixed effects.
# - Keep column progression interpretable.
# - Export booktabs LaTeX for manuscripts.
# - Keep HTML only for slides or diagnostics.
