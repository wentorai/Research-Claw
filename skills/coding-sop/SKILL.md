---
name: Coding SOP
description: >-
  Standard operating procedure for research experiments, data analysis,
  and visualization. Covers Python/R script execution, statistical analysis,
  data wrangling (pandas/tidyverse), publication-quality figures
  (matplotlib/plotly/ggplot2), and experiment reproducibility.
---

<!-- MAINTENANCE NOTES:
     Scope: research code (experiments, data, viz, stats). NOT software engineering
     (→ claude-code/codex-cli). Boundaries: workspace-sop (files/versions),
     search-sop (literature), writing-sop (prose/LaTeX), output-cards (card schemas).
     Sources: AGENTS.md §4 (exec safety) + new content. Size budget: ≤10K bytes.
-->

# Coding SOP — Research Experiments & Data Analysis

## 1. Experiment Execution SOP

### 1.1 Hypothesis → Code → Execute → Verify

1. **Hypothesize**: state what you expect and why
2. **Design**: define variables, controls, sample size / iteration count
3. **Code**: `workspace_save` to `outputs/scripts/`; include docstring (hypothesis,
   expected outcome, dependencies)
4. **Execute**: `exec` in workspace (safe commands — see §5); capture stdout + stderr
5. **Verify**: compare against hypothesis; check for NaN/Inf/warnings; save to
   `outputs/reports/`
6. **Iterate**: if contradicted, revise (do NOT cherry-pick); if confirmed, document

### 1.2 Script Template

Every script must include: shebang, docstring (experiment title, hypothesis,
dependencies, date), seed setting (see §6), and four sections: loading,
processing, analysis, output.

## 2. Data Processing SOP

### 2.1 Pipeline: Clean → Transform → Analyze

1. **Inspect**: `df.info()`, `df.describe()`, `df.head()` — check dtypes, nulls, duplicates
2. **Clean**: handle missing values (drop/impute/flag — document choice), fix dtypes,
   remove duplicates, detect outliers (IQR, z-score, domain rules)
3. **Transform**: normalize/standardize, encode categoricals, feature engineering,
   reshape (pivot, melt, merge)
4. **Validate**: assert expected shape, sanity-check stats, save cleaned data via
   `workspace_save("sources/data/<name>_clean.csv")`

### 2.2 Common Libraries

**Python**: pandas/polars (DataFrames), numpy (numerics), dask (large files),
spaCy (text). **R**: dplyr/tidyr (wrangling), data.table/arrow (large files),
stringr/tidytext (text).

Browse `analysis/wrangling/` for 10 deep-dive skills (pandas, missing data, survey, text mining).

## 3. Statistical Analysis Guide

### 3.1 Test Selection Tree

```
What is your research question?
│
├── Comparing groups?
│   ├── 2 groups
│   │   ├── Continuous DV, normal → Independent t-test
│   │   ├── Continuous DV, non-normal → Mann-Whitney U
│   │   ├── Paired/matched → Paired t-test / Wilcoxon signed-rank
│   │   └── Categorical DV → Chi-square / Fisher's exact
│   ├── 3+ groups
│   │   ├── 1 factor, normal → One-way ANOVA → post-hoc (Tukey/Bonferroni)
│   │   ├── 1 factor, non-normal → Kruskal-Wallis → post-hoc (Dunn)
│   │   ├── 2+ factors → Two-way / N-way ANOVA (check interactions)
│   │   └── Repeated measures → Repeated-measures ANOVA / Friedman
│   └── Pre/post with control → Mixed ANOVA / DiD
│
├── Predicting an outcome?
│   ├── Continuous outcome → Linear regression (OLS)
│   │   ├── Multiple predictors → Multiple regression
│   │   ├── Non-linear → Polynomial / GAM / splines
│   │   └── Endogeneity → IV / 2SLS (see econometrics skills)
│   ├── Binary outcome → Logistic regression
│   ├── Count/ordinal → Poisson / Ordinal logistic
│   ├── Time-to-event → Cox proportional hazards
│   └── Panel data → Fixed/random effects (see econometrics skills)
│
├── Exploring relationships?
│   ├── 2 continuous vars → Pearson r (normal) / Spearman rho (non-normal)
│   ├── 2 categorical vars → Chi-square test of independence
│   ├── Latent constructs → Factor analysis / SEM
│   └── Dimensionality → PCA / t-SNE
│
└── Estimating causal effects?
    ├── Randomized experiment → t-test / ANOVA with random assignment
    ├── Natural experiment → DiD, RDD, IV
    └── Observational → Propensity score matching, synthetic control
```

### 3.2 Reporting Checklist

Every test must report: test name, statistic value (t/F/chi-sq/U/z), df, exact
p-value, effect size (Cohen's d / eta-sq / Cramer's V / OR), 95% CI, assumptions
checked (normality, homoscedasticity, independence), sample size per group.

### 3.3 Common Pitfalls

- **Multiple comparisons**: Bonferroni, Holm, or FDR correction
- **p-hacking**: pre-register hypotheses; never fish for p < 0.05
- **Small samples**: exact tests or bootstrap over asymptotic tests
- **Normality**: Shapiro-Wilk (n < 50) or Q-Q plot + KS test
- **Confounders**: include as covariates or stratify

**Deep-dive skills**: browse `analysis/statistics/` (10 skills: Bayesian, meta-analysis,
SEM, survival, power analysis, nonparametric) and `analysis/econometrics/` (12 skills:
causal inference, panel data, IV, time series).

## 4. Visualization SOP

### 4.1 Chart Type Selection

| Data pattern | Chart type |
|:-------------|:-----------|
| Distribution (1 var) | Histogram, KDE, box/violin plot |
| Comparison (categories) | Bar chart, grouped bar, dot plot |
| Trend over time | Line chart, area chart |
| Relationship (2 vars) | Scatter plot, regression plot |
| Correlation matrix | Heatmap |
| Composition | Stacked bar, treemap |
| Geographic | Choropleth, point map |
| Network / graph | Force-directed, adjacency matrix |
| High-dimensional | PCA biplot, t-SNE, UMAP |

### 4.2 Publication-Quality Standards

Set `plt.rcParams` for journal figures: `figure.dpi: 300`, `font.family: serif`,
`font.size: 10`, `savefig.bbox: tight`. Key rules:

1. **Resolution**: 300 DPI minimum (600 DPI for line art)
2. **Format**: PDF/SVG for vector; PNG/TIFF for raster (avoid JPEG)
3. **Color**: colorblind-safe palettes (viridis, cividis, Set2)
4. **Labels**: every axis labeled with units; legend outside if crowded
5. **Font**: 8-12pt, match journal spec (serif or sans-serif)
6. **Size**: single column ~3.5in, double column ~7in width
7. **Save**: `workspace_save("outputs/figures/fig-<desc>.pdf", content)`

**Deep-dive skills**: browse `analysis/dataviz/` (14 skills: matplotlib, plotly, D3,
publication figures, color accessibility, geospatial, network viz).

## 5. exec Safety & Patterns

**Safe** (no approval): `python3`, `Rscript`, `xelatex`, `pandoc`, `jq`, `wc`, `grep`, `find`.
**Requires approval_card**: `pip install`, `brew install`, `curl`, `wget`, anything outside workspace.
Full safety rules in **Workspace SOP**.

Common patterns:
- `exec("python3 outputs/scripts/experiment.py")` — run analysis
- `exec("Rscript outputs/scripts/analysis.R")` — R script
- `exec("python3 -c \"import pandas; ...\"")` — quick inspection

**Output paths**: All script outputs (figures, data, reports) MUST use
workspace-relative paths. Set the working directory to workspace root before
execution, and use paths like `outputs/figures/`, `outputs/reports/`.
Template for Python:
```python
import os
os.chdir(os.environ.get('WORKSPACE_ROOT', '.'))
```

## 6. Reproducibility Protocol

### 6.1 Environment Recording

At analysis start, capture Python version, platform, and key package versions
(numpy, pandas, scipy, matplotlib, sklearn). Save via
`workspace_save("outputs/reports/env-snapshot-<date>.json")`.

### 6.2 Reproducibility Checklist

- **Random seeds**: Set at script top for numpy, random, torch, tensorflow
- **Version locking**: Record exact versions (pip freeze / conda list)
- **Data provenance**: Source URL, download date, SHA-256 for raw data
- **Execution order**: Scripts must run independently (no notebook-state dependency)
- **Relative paths**: Use workspace-relative paths, not absolute
- For ML: log hyperparams, track metrics per step, save checkpoints, record hardware

## 7. Coding Complexity Delegation

Before writing code, assess complexity:

```
Simple task (single file, stdlib only, no iteration)
  → RC handles directly via exec
Complex task (multi-file, dependencies, iterative debugging)
  → Check MEMORY.md Environment for installed CLIs (codex, claude, opencode)
    → CLI found → inform user, suggest delegating via exec
      → User agrees → exec the CLI (read claude-code / codex-cli / opencode-cli skill)
      → User wants RC → proceed with RC's own capabilities
    → No CLI → recommend installation, wait for user decision
      → User insists → RC proceeds via repeated workspace_save + exec (slower)
```

**Boundary**: "complex coding" = multi-file projects, dependency management, iterative
debugging, beamer/multi-chapter LaTeX, interactive visualizations. For these, the
**Claude Code**, **Codex CLI**, and **OpenCode CLI** skills provide delegation guidance.

## 8. RC Local Tools Reference

- **workspace_save**: persist code to `outputs/scripts/` (or `outputs/notebooks/`),
  figures to `outputs/figures/`, processed data to `sources/data/`.
  Commit message prefix: `Add:` / `Update:`.
- **workspace_append**: add results to an existing report or data file without
  overwriting. Preferred over read + save for incremental updates.
- **workspace_download**: save binary outputs (plots, exports) from URLs.
- **exec**: run scripts from workspace root. Default timeout 120s (increase for
  long-running). Always inspect both stdout and stderr. On failure: fix code,
  `workspace_save` again, re-run.

## Related Research-Plugins Skills

For detailed methodology beyond this SOP, browse these RP skill indexes:

| Index path | Skills | Covers |
|:-----------|:-------|:-------|
| `tools/code-exec/` | 7 | Jupyter, Colab, Kaggle, reproducibility (Python/R) |
| `analysis/statistics/` | 10 | Hypothesis testing, Bayesian, meta-analysis, SEM, survival |
| `analysis/econometrics/` | 12 | Causal inference, panel data, IV, DiD, time series, Stata |
| `analysis/wrangling/` | 10 | pandas, data cleaning, missing data, survey, text mining |
| `analysis/dataviz/` | 14 | matplotlib, plotly, D3, publication figures, geospatial, networks |
| `domains/ai-ml/` | 27 | PyTorch, TensorFlow, LLM eval, experiment tracking, ML pipelines |
| `tools/diagram/` | 9 | Mermaid, PlantUML, GraphViz, flowcharts, scientific diagrams |
| `domains/` | 147 | 16 disciplines — browse `domains/{field}/` for domain-specific analysis methods |
