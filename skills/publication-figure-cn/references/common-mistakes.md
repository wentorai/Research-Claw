# 国内学者高频配图错误清单

按出现频率排序。每条给出**反模式**、**为什么不行**、**修法**。审稿前自查清单。

## 1. 用 Helvetica / Arial 当中文字体邻居

**反模式**：图里西文是 Helvetica 或 Arial（matplotlib 默认 sans-serif），与正文 Times/宋体格格不入。

**为什么不行**：中文期刊正文宋体（衬线），图里 sans-serif 在版面里特别突兀；显得不专业。

**修法**：

```python
plt.rcParams['font.family'] = 'serif'
plt.rcParams['font.serif'] = [
    'Times New Roman', 'SimSun', 'Songti SC',
    'Source Han Serif SC', 'Noto Serif CJK SC'
]
```

## 2. 中文显示成方块（豆腐块 ☐☐☐）

**反模式**：matplotlib 没装中文字体，标题、坐标轴中文一片方块。

**为什么不行**：直接打回，审稿人不会忍。

**修法**：

```python
import matplotlib.font_manager as fm
# 检查可用字体
fonts = [f.name for f in fm.fontManager.ttflist]
print([f for f in fonts if 'Song' in f or 'Sim' in f or 'Hei' in f])

# 强制使用某个已存在的中文字体
plt.rcParams['font.serif'] = ['Songti SC', 'SimSun']  # 至少一个真实存在
plt.rcParams['axes.unicode_minus'] = False  # 必加，否则负号也是方块
```

macOS 自带 `Songti SC` 和 `STSong`；Windows 自带 `SimSun`；Linux 用 `Source Han Serif SC` 或 `Noto Serif CJK SC`（apt 装 `fonts-noto-cjk`）。

## 3. 配色花哨（彩虹 jet / rainbow / 默认 tab10 8 色）

**反模式**：相关矩阵热图用 `cmap='jet'`，5+ 组折线图用默认 `tab10` 全彩。

**为什么不行**：
- jet/rainbow 灰度不单调，黑白印刷错乱
- tab10 彩印 OK，黑白打印 tab:blue 与 tab:orange 灰度接近、糊
- 色盲患者部分组不可分

**修法**：见 `colorblind-bw.md`，黑白用 `BlackWhite + hatch + marker`，彩印用 `Okabe-Ito 8 色`。

## 4. 线太细（默认 0.5pt）

**反模式**：用 matplotlib 默认 `linewidth=0.5pt` / `axes.linewidth=0.8`。

**为什么不行**：缩印到单栏 8.5cm 后，0.5pt 的线接近消失，PDF 阅读器低分辨率下完全看不见。

**修法**：

```python
plt.rcParams.update({
    'lines.linewidth': 1.5,
    'axes.linewidth': 0.8,
    'xtick.major.width': 0.8,
    'ytick.major.width': 0.8,
    'lines.markersize': 5,
})
```

## 5. 标签写英文（"Year"、"GDP"、"Treated"、"Control"）

**反模式**：中文期刊正文里图的轴标签、图例是英文。

**为什么不行**：
- 中文期刊一律要求中文标签
- 审稿人会觉得作者偷懒（直接复用英文论文图）

**修法**：所有标签翻译——`Year → 年份`、`GDP → 国内生产总值`、`Treated → 处理组`、`Control → 对照组`、`Pre/Post → 政策前/政策后`、`Coefficient → 系数`、`Standard Error → 标准误`、`95% CI → 95% 置信区间`。

数学符号、常见单位（%）可保留英文。

## 6. 双纵轴 (twinx) 比例尺乱用

**反模式**：左轴 GDP 增长率 (0–10%)，右轴 CPI (90–110)，两条线**人为相交**视觉上像是负相关。

**为什么不行**：双轴可以制造任何想要的"相关性"假象，是众矢之的的视觉欺骗。审稿人/读者第一反应：**作者在骗我**。

**修法**：

- **优先**：拆子图（上下两个 panel 各一根线）
- **次选**：标准化到 z-score 后画一根轴
- **如必须双轴**：明确标注两轴单位、说明零点对齐方式、且**两条线趋势相同**（同向才用双轴有意义）

## 7. 三线表画了竖线（Excel 默认风格）

**反模式**：从 Excel 复制过来 / Word 表格默认带竖线 + 内部横线。

**为什么不行**：不是三线表。中文期刊几乎一律要求三线表。

**修法**：见 `three-line-table.md`。LaTeX 用 booktabs：`\toprule \midrule \bottomrule`，**任何竖线、内部横线一律删除**。

## 8. y 轴起点压缩 / 截断未标注

**反模式**：柱状图 y 轴从 95 开始而不是 0，让 0.5% 的差异看起来像 50%。

**为什么不行**：明确的视觉欺骗。期刊审稿人/读者会逮到。

**修法**：

- 原则上 y 起点为 0
- 如必须截断，**画断轴标记**（broken axis）或**清晰标注 "y 轴从 95 开始"**
- 折线图（不强求 0 起点）相对宽松，但要有明确语义

## 9. 没有图注 / 表注

**反模式**：图下面光秃秃只有一个 "图1"，不写样本、变量、显著性、来源。

**为什么不行**：图表必须**离开正文也能读懂**，这是中文期刊明文要求。

**修法**：每张图 / 表必含：

```
注：(1) 样本范围；(2) 变量定义；(3) 标准误聚类层级；
    (4) 显著性符号；(5) 数据来源。
```

## 10. 字号 12pt 默认 + 不缩放

**反模式**：figsize 默认 (6.4, 4.8) + fontsize 12pt，导出后塞到论文单栏 8.5cm 里，整张图都被缩到 50%，字看不清。

**为什么不行**：matplotlib 默认是为屏幕（dpi=100）设计的，不是为 8.5cm 印刷版心。

**修法**：用**最终印刷尺寸的 figsize**：

```python
fig, ax = plt.subplots(figsize=(3.3, 2.5))  # 单栏 8.5cm
plt.rcParams['font.size'] = 9  # 缩到 8.5cm 后字号刚好 9pt
fig.savefig('fig.pdf', dpi=300, bbox_inches='tight')
```

LaTeX `\includegraphics[width=\columnwidth]{fig.pdf}` 时**不要再缩放**。

## 11. 导出 PNG / JPG

**反模式**：`plt.savefig('fig1.png')` 然后投稿。

**为什么不行**：
- PNG/JPG 是位图，缩放会糊
- 期刊排版不接受位图（部分接受 600+ DPI 的 PNG，但 PDF 永远更稳）

**修法**：

```python
fig.savefig('fig1.pdf', dpi=300, bbox_inches='tight', pad_inches=0.05)
```

## 12. 子图标号用 "1." "2." 阿拉伯数字 / "Panel A"

**反模式**：子图左上角写 `Panel A` / `Panel B`，或写 `1.` `2.`。

**为什么不行**：
- 中文期刊偏好 `(a) (b) (c)` 小写括号字母
- "Panel A/B" 是英文期刊用法

**修法**：

```python
ax.text(0.02, 0.98, '(a)', transform=ax.transAxes,
        fontsize=10, fontweight='bold', va='top')
```

## 13. 多张图风格不统一

**反模式**：图1 默认彩色、图2 黑白、图3 又是另一种风格。

**为什么不行**：不专业，审稿人感觉"作者随便糊弄"。

**修法**：所有图共用一个 `matplotlibrc` 或 `plt.style.use('mystyle.mplstyle')`。

## 14. 公式 / 变量符号没用 LaTeX

**反模式**：`$R^2 = 0.34$` 写成 `R2 = 0.34` 直接显示出来。

**修法**：matplotlib 支持 LaTeX：`ax.set_ylabel(r'$R^2$')`，`ax.set_title(r'$\beta$ 系数动态变化')`。注意原始字符串 `r'...'` 与 `$...$` 包裹。

## 15. 图序与正文不一致

**反模式**：正文写"如图3所示"，但图3 实际显示的是图2 的内容。

**修法**：投稿前**逐一核对**正文图序与图标题。LaTeX 用 `\ref{fig:main}` 自动编号。

---

## 自查清单（投稿前 5 分钟）

- [ ] 中文显示正常，无方块
- [ ] 字体衬线（serif），中文宋体、西文 Times
- [ ] 字号 9–10pt，导出尺寸 = 印刷尺寸
- [ ] 黑白打印或灰度模拟下仍可读
- [ ] 多序列同时用 marker + linestyle 区分
- [ ] 三线表无竖线、无内部横线
- [ ] 每张图 / 表都有"注："和数据来源
- [ ] y 轴 0 起点或明确标注截断
- [ ] 子图标号 `(a) (b) (c)`
- [ ] 导出 PDF 矢量、300+ DPI、bbox_inches='tight'
- [ ] 图序与正文匹配
