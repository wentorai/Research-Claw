# 7 类常用学术图——各自规范

每类配套 `templates/` 下同名脚本。本文给出**何时用、关键参数、常见错误**。

## 1. 折线图 / 时间序列（line chart）

**何时用**：
- 时间趋势（GDP、利率、市场指数）
- 多组随时间变化的对比（处理组 vs 对照组事件研究前置图）

**关键参数**：
- `linewidth=1.5`，`markersize=5`
- 多序列必须用 marker + linestyle 区分（不是只换颜色）
- x 轴时间：年用整数，季度用 `2020Q1`，月用 `2020-01`

**常见错误**：
- ❌ y 轴起点不是 0 又没标注（视觉欺骗）
- ❌ 6+ 条线挤在一张图（拆子图或表格）
- ❌ 时间轴乱序 / 跳跃

模板：`templates/line_chart.py`

## 2. 柱状图 / 条形图（bar chart）

**何时用**：
- 分类对比（行业、地区、年份）
- 带误差棒的均值比较
- 分组（grouped）柱状图比较多组分类

**关键参数**：
- `width=0.6` 单组；`width=0.35` 双组并列
- 误差棒：`yerr=se, capsize=3, ecolor='black', elinewidth=1.0`
- hatch 填充（黑白打印必加）

**常见错误**：
- ❌ 默认彩色无 hatch（黑白印不出区别）
- ❌ y 轴起点压缩（夸大差异）
- ❌ 横向柱状图（barh）排序混乱

模板：`templates/bar_chart.py`

## 3. 系数图 / Forest plot（coefficient plot）

**何时用**：
- DiD 事件研究：处理前/后 -k…+k 期的动态系数
- IV 系数对比（OLS vs 2SLS vs LIML）
- 异质性分析（按子样本回归的系数）

**关键参数**：
- 横向：x = 时间 / 期数，y = 系数 + 95% CI
- 纵向（forest）：y = 模型名 / 子样本，x = 系数 + 95% CI
- **必有水平参考线 y=0**（`axhline(0, lw=0.5, color='gray', ls='--')`）
- 处理时点用垂直参考线（事件研究）
- 误差棒 / 置信区间：`fill_between(... alpha=0.2)` 或 `errorbar(...)`

**常见错误**：
- ❌ 没标 0 参考线
- ❌ 95% CI vs 90% CI 混用没说明
- ❌ 缺事件研究中的 t = -1 基期标识
- ❌ 把所有系数挤一张图、不分子图

模板：`templates/coefficient_plot.py`

## 4. 散点图（含拟合线）

**何时用**：
- 双变量关系展示
- bin scatter（分箱散点，金融经济学常用）
- 主回归的 partial residual plot

**关键参数**：
- `s=20, alpha=0.5`（密集点必加 alpha）
- 拟合线：`ax.plot(x_grid, y_pred, lw=1.5, color='black')`
- 95% CI 阴影：`ax.fill_between(x_grid, y_lo, y_hi, alpha=0.2)`
- 必标 R² 或回归系数（图角文本）

**常见错误**：
- ❌ 不加 alpha，1 万点重叠成黑块
- ❌ 拟合线超出数据范围（外推）
- ❌ R²、N 没标在图里

模板：`templates/scatter_with_fit.py`

## 5. 箱线图（box plot）

**何时用**：
- 分组分布对比（多个行业的 ROA 分布）
- 异常值识别
- 实验组 / 对照组的分布比较

**关键参数**：
- `whis=1.5`（默认 1.5 IQR，常用）
- `showfliers=True / False`（密集数据可关闭）
- 中位数线加粗
- 同时用 `notch=True` 显示 95% CI 切口（如组间差异检验）

**常见错误**：
- ❌ 箱体颜色花哨，黑白印不清
- ❌ 不写样本量 N（每组）
- ❌ 仅给箱图、不报均值（建议叠加均值点）

模板：`templates/box_plot.py`

## 6. 热图 / 相关矩阵（heatmap）

**何时用**：
- 变量相关系数矩阵
- 双变量交互效应（处理 × 时间）
- 行业 × 年的某指标分布

**关键参数**：
- 发散色阶 `RdBu_r` / `PuOr`，`vmin=-1, vmax=1`，`center=0`
- 顺序色阶 `viridis`（全正或全负数据）
- **必显示 colorbar 并标 label**
- 热图格内显示数值（`annot=True, fmt='.2f'`），尤其相关矩阵
- 字号缩到 7–8pt 防溢出

**常见错误**：
- ❌ 用 `jet` / `rainbow`（科学可视化反模式）
- ❌ 发散数据用顺序色阶
- ❌ 单元格没数值，单看色块猜不出
- ❌ 矩阵太大（30x30）压成一坨

模板：`templates/heatmap.py`

## 7. 直方图 / 密度图（histogram / KDE）

**何时用**：
- 单变量分布
- 处理 / 对照协变量平衡检查
- 处理 / 对照倾向得分分布（PSM）

**关键参数**：
- `bins=30`（默认），数据多则 `bins='auto'` 或 Freedman-Diaconis
- `density=True` 归一化（多组叠加）
- `alpha=0.5` 让多组重叠可见
- 叠加均值 / 中位数垂直线（`axvline`）

**常见错误**：
- ❌ bin 数太少（10 个 bin 看不出形状）
- ❌ 多组堆叠（stacked）vs. 重叠（overlay）混淆
- ❌ 不给均值 / 中位数辅助线

无独立模板（直方图 ≈ bar chart 简化版，柱图模板可复用），如需可加 `templates/histogram.py`。

## 通用建议

- **每张图 ≤ 1 个核心信息**——多于一个时拆子图
- **图标题写信息**："图1 政策冲击对 R&D 投入的动态效应"，不写 "Figure of effect"
- **图注说样本、变量、显著性**——审稿人不读正文也能懂图
- **导出 PDF 矢量** —— 缩放不糊
