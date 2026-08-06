# 三线表规范

中文期刊**几乎统一**使用三线表（three-line table）。本文给出规范、LaTeX 实现（booktabs）、Word 实现，以及跨表头的处理。

## 1. 什么是三线表

只有 **3 条横线**：

```
═══════════════════════════════   ← top rule（顶线，较粗 1.0–1.5pt）
变量    系数    标准误   N
───────────────────────────────   ← mid rule（中线，较细 0.5pt，置于表头之下）
treat   0.123   0.045    1,200
post    0.078   0.039    1,200
treat×post   0.156**  0.062  1,200
═══════════════════════════════   ← bottom rule（底线，与顶线同粗）
注：括号内为聚类到企业层面的标准误。***/**/* 分别表示 1%/5%/10% 显著性。
```

**严格禁止**：

- 任何竖线（vertical lines）
- 任何中间横线（除非是分组的 cmidrule，见下文）
- 表格框（外框）

## 2. 线粗规范

| 线 | 粗细 | LaTeX 命令 |
|----|------|-----------|
| 顶线 | 0.08em ≈ 1.5pt | `\toprule` |
| 中线 | 0.05em ≈ 0.5pt | `\midrule` |
| 底线 | 0.08em ≈ 1.5pt | `\bottomrule` |
| 跨列子线 | 0.03em ≈ 0.3pt | `\cmidrule(lr){2-3}` |

## 3. LaTeX 实现（booktabs，强烈推荐）

```latex
\usepackage{booktabs}
\usepackage{threeparttable}  % 表注

\begin{table}[!htbp]
  \centering
  \caption{表1 政策冲击对企业 R\&D 投入的影响}
  \label{tab:main}
  \begin{threeparttable}
  \begin{tabular}{lccc}
    \toprule
                   & (1)        & (2)        & (3)        \\
                   & R\&D/资产  & R\&D/资产  & 专利数(对数) \\
    \midrule
    Post           & 0.012**    & 0.011**    & 0.045*     \\
                   & (0.005)    & (0.005)    & (0.024)    \\
    Post×Treat     & 0.156***   & 0.143***   & 0.231***   \\
                   & (0.045)    & (0.043)    & (0.072)    \\
    \midrule
    控制变量       & 否         & 是         & 是         \\
    企业固定效应   & 是         & 是         & 是         \\
    年度固定效应   & 是         & 是         & 是         \\
    样本量 N       & 38,420     & 38,420     & 38,420     \\
    R$^2$          & 0.21       & 0.34       & 0.41       \\
    \bottomrule
  \end{tabular}
  \begin{tablenotes}\footnotesize
    \item 注：括号内为聚类到企业层面的标准误。***/**/* 分别表示在 1\%/5\%/10\% 水平下显著。
    \item 数据来源：CSMAR 数据库。
  \end{tablenotes}
  \end{threeparttable}
\end{table}
```

完整可编译版本见 `templates/three_line_table_latex.tex`。

## 4. 跨列表头（multi-column header）

DiD/IV 论文常需要"基准 / 稳健性 / 异质性"分组。用 `\multicolumn` + `\cmidrule`：

```latex
\begin{tabular}{lcccccc}
  \toprule
              & \multicolumn{2}{c}{基准}  & \multicolumn{2}{c}{IV}    & \multicolumn{2}{c}{安慰剂} \\
  \cmidrule(lr){2-3}\cmidrule(lr){4-5}\cmidrule(lr){6-7}
              & (1) & (2) & (3) & (4) & (5) & (6) \\
  \midrule
  Post×Treat  & 0.156*** & 0.143*** & 0.187*** & 0.171*** & 0.012 & 0.018 \\
              & (0.045)  & (0.043)  & (0.062)  & (0.059)  & (0.041) & (0.040) \\
  \bottomrule
\end{tabular}
```

`\cmidrule(lr){a-b}` 的 `(lr)` 让横线两端略缩进，避免接到下一组横线。

## 5. Word 实现

如果不能用 LaTeX：

1. 插入 → 表格
2. 选中整张表 → 设计 → 边框 → **无框线**
3. 选第一行 → 上边框 1.5pt + 下边框 0.5pt
4. 选最后一行 → 下边框 1.5pt
5. 字号：**5 号（10.5pt）正文，小 5 号（9pt）表注**
6. 表标题在表上方，表注在表下方："注：……"

## 6. 表注（table notes）

- **位置**：表下方
- **格式**：`注：××××××。\n 数据来源：××××。`
- 显著性符号说明：`***/**/* 分别表示在 1%/5%/10% 水平下显著`
- 标准误说明：`括号内为×××标准误`
- 必要时分行：第一行通用注释，第二行数据来源

## 7. 数字对齐

LaTeX 中数字应**小数点对齐**。两种做法：

```latex
% 方法 1：siunitx (推荐)
\usepackage{siunitx}
\begin{tabular}{l S[table-format=2.3] S[table-format=1.3]}
  \toprule
  变量 & {系数} & {标准误} \\
  \midrule
  treat & 12.345 & 0.045 \\
  post  &  0.123 & 0.039 \\
  \bottomrule
\end{tabular}

% 方法 2：手动 phantom
\begin{tabular}{lcc}
  treat & \phantom{0}12.345 & 0.045 \\
  post  & \phantom{00}0.123 & 0.039 \\
\end{tabular}
```

## 8. 显著性标星

中文期刊主流：**右上角星号** `0.156***`。

- 一般用 ***/**/* 三档对应 1%/5%/10%
- **不要用** † 或 ‡（部分会计期刊用，但少见）
- 标星跟在系数后，不跟在标准误后
- 标准误用括号 `(0.045)`，t 值用方括号 `[2.45]`，z 值同 t

## 9. 表格命名

- 中文"表1 / 表2"，**不是** "Table 1"
- 英文论文里如出现中文表名，需翻译；中文论文里不要混用

## 10. 高频错误

1. **画了竖线**——Excel 默认会带，必须删
2. **画了中间横线**——除了表头之下那条
3. **顶线与底线一样细**——顶/底应比中线粗
4. **表注写成 Notes:**——应用"注：" 中文冒号
5. **跨列表头没用 cmidrule**——审稿人会嫌"读不清分组"
6. **数字没对齐**——尤其负数、千分位
