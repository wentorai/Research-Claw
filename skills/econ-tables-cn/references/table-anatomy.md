# 三线表解剖（Three-Line Table Anatomy）

经管研究的"三线表"是 LaTeX `booktabs` 包推广的标准学术表格规范，被 AER / JF / RFS / JFE / 经济研究 / 管理世界 全部采纳。本文档拆解一张完整三线表的所有组件。

## 1. 三条横线（核心）

| 线 | LaTeX 命令 | 粗细 | 作用 |
|---|---|---|---|
| top-rule    | `\toprule`    | 0.08em (粗) | 表格最顶端 |
| mid-rule    | `\midrule`    | 0.05em (细) | header 与数据之间 |
| bottom-rule | `\bottomrule` | 0.08em (粗) | 表格最底端 |

**禁止**：竖线、表内多余横线（除了 `\cmidrule` 用于跨列分组）。

## 2. 标准结构（自上而下）

```
+--------------------------------------------+
|  Table N: 主标题                              |
|  Panel A: 子分组（可选）                        |
+============================================+ ← \toprule
|         | (1)  | (2)  | (3)  | (4)         |
|         | OLS  | FE   | IV   | DiD         |
+--------------------------------------------+ ← \cmidrule(lr){2-5}（可选）
| Treat   | 0.123*** | 0.087** | 0.156** | 0.092*** |
|         | (0.034)  | (0.041) | (0.072) | (0.025)  |
| Size    | 0.045*   | 0.041   | -       | 0.038    |
|         | (0.024)  | (0.028) |         | (0.022)  |
+--------------------------------------------+ ← \midrule
| Firm FE | No   | Yes  | Yes  | Yes         |
| Year FE | No   | Yes  | Yes  | Yes         |
| Controls| Yes  | Yes  | Yes  | Yes         |
| N       | 5,000| 5,000| 5,000| 5,000       |
| R²      | 0.21 | 0.43 | 0.35 | 0.41        |
+============================================+ ← \bottomrule
| Note: 表注：聚类层级、显著性、控制变量列表           |
+--------------------------------------------+
```

## 3. 系数行的两行写法

每个解释变量占据 **两行同一列**：

```
Treat       0.123***       ← 第一行：估计值 + 显著性星号
            (0.034)        ← 第二行：标准误 / t 值（括号包裹）
```

LaTeX 实现（estout/esttab、modelsummary、stargazer 默认都生成此格式）：

```latex
Treat & 0.123\sym{***} \\
      & (0.034)        \\
```

**反例**（严格禁止）：把系数和 SE 写到两列里 —— 这样审稿人无法快速对位。

## 4. 表底必报指标

| 指标 | 适用 | 备注 |
|---|---|---|
| N (Observations)  | 全部 | 显示在最底部 |
| R²                | OLS  | 必报 |
| Adj. R²           | OLS  | 经管/JF/MS 都要求 |
| Within R²         | FE   | reghdfe 默认输出，必报 |
| Pseudo-R²         | Logit/Probit | McFadden's |
| KP rk Wald F      | IV   | 弱工具变量检验，> 10 |
| Hansen J p-value  | GMM / 过度识别 IV | > 0.10 不拒绝 |
| RMSE              | 部分期刊 | JF/MS 不强制 |

## 5. FE 与控制变量的标注

**永远在表底独立行**：

```
Firm FE       Yes   Yes   Yes
Year FE       No    Yes   Yes
Industry FE   No    No    Yes
Controls      Yes   Yes   Yes
```

中英文写法均可：`Yes/No` 或 `✓ / ×` 或 `Y/N`。**不要写在系数行**。

## 6. 表注（Note）规范

表注必须包含三件事：

1. **聚类层级**："Standard errors clustered at the firm-year level."
2. **显著性符号**：`*** p<0.01, ** p<0.05, * p<0.10`
3. **控制变量列表**（如果未在表内列出）：列出所有 controls 的具体变量名

LaTeX 用 `threeparttable` 包实现：

```latex
\begin{threeparttable}
\begin{tabular}{lcccc}
...
\end{tabular}
\begin{tablenotes}
\small
\item Notes: ... 
\end{tablenotes}
\end{threeparttable}
```

## 7. Panel 分组（多 panel 表）

```
Panel A: Full sample
... (一张完整三线表)
Panel B: Split by firm size
... (另一张完整三线表)
```

每个 panel 独立的 toprule/midrule/bottomrule，或共享外框 + `\cmidrule` 分隔。
