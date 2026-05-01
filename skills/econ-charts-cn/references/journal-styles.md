# Journal Styles For Econ Charts

This reference provides conservative defaults. Treat journal-specific author instructions as authoritative when available.

4 期刊图表样式对照：《经济研究》《管理世界》《Journal of Finance》《Management Science》。给出字体、字号、颜色、线宽、标记、图说位置等可直接转化为 matplotlib / ggplot2 / Stata grstyle 配置的参数。

---

## 1. 《经济研究》

中国经济学顶刊，倾向**简洁、黑白、严谨**。

| 项目 | 设置 |
|------|------|
| 中文字体 | 宋体（SimSun / Songti SC） |
| 英文 / 数字字体 | Times New Roman |
| 主标题字号 | 11 pt（图标题在图下方，"图 X：标题"） |
| 坐标轴标签字号 | 9–10 pt |
| 刻度字号 | 8–9 pt |
| 图例字号 | 8–9 pt |
| 颜色 | **强烈倾向 B&W**；多组用灰度 + 不同 marker |
| 线宽 | 主线 1.0–1.2 pt；参考线 0.6 pt 灰虚线 |
| Marker | 实心圆 / 空心圆 / 三角 / 方块 组合区分 |
| 图说位置 | **图下方**，"注：……数据来源：……" |
| 单栏宽 | 8.5 cm |
| 双栏宽 | 17 cm |

典型配色：`["#000000", "#595959", "#A6A6A6", "#D9D9D9"]`（4 组以内灰度梯度）

---

## 2. 《管理世界》

中国管理学顶刊，倾向**简洁、可少量低饱和彩色、突出政策语境**。

| 项目 | 设置 |
|------|------|
| 中文字体 | 宋体 |
| 英文 / 数字字体 | Times New Roman |
| 主标题字号 | 10–11 pt |
| 坐标轴标签字号 | 9 pt |
| 刻度字号 | 8 pt |
| 图例字号 | 8 pt |
| 颜色 | 黑白优先；最多两种**低饱和**冷色（深蓝 + 灰） |
| 线宽 | 主线 1.0 pt |
| Marker | 实心圆 / 三角 |
| 图说位置 | 图下方 |
| 单栏宽 | 8.5 cm |
| 双栏宽 | 17 cm |

典型配色：`["#1F3864", "#7F7F7F", "#404040"]`（深蓝 + 中灰 + 深灰）

---

## 3. Journal of Finance (JF)

国际金融顶刊，倾向**专业、低饱和蓝灰系、严谨**。

| 项目 | 设置 |
|------|------|
| 字体 | Times New Roman（正文）/ Helvetica 或 Arial（坐标轴可选） |
| 主标题字号 | 11–12 pt |
| 坐标轴标签字号 | 10 pt |
| 刻度字号 | 9 pt |
| 图例字号 | 9 pt |
| 颜色 | 蓝灰系 + 黑白；偶用一抹红色高亮 |
| 线宽 | 主线 1.2–1.5 pt；参考线 0.8 pt |
| Marker | 实心圆 / 方块；CI 用阴影带（fill_between）也可 |
| 图说位置 | 图上方或下方均可（多在下方）"Figure X. Title" |
| 单栏宽 | 3.5 inch（约 8.9 cm） |
| 双栏宽 | 7.0 inch（约 17.8 cm） |

典型配色：`["#08306B", "#4292C6", "#9ECAE1", "#08519C", "#C6111E"]`

---

## 4. Management Science (MS)

国际管理学顶刊，**允许较丰富色谱**，但仍以专业感为主。

| 项目 | 设置 |
|------|------|
| 字体 | Times New Roman / Helvetica |
| 主标题字号 | 11–12 pt |
| 坐标轴标签字号 | 10 pt |
| 刻度字号 | 9 pt |
| 图例字号 | 9 pt |
| 颜色 | viridis / cividis 色谱；3+ 组允许使用 ColorBrewer Set2 |
| 线宽 | 主线 1.2 pt |
| Marker | 圆 / 方 / 三角 组合，部分图允许填充色 |
| 图说位置 | 图上方："Figure X. Title"（"Notes."另起段） |
| 单栏宽 | 3.5 inch |
| 双栏宽 | 7.0 inch |

典型配色：viridis 离散 5 色 `["#440154", "#3B528B", "#21908C", "#5DC863", "#FDE725"]`

---

## 切换样式的工程方法

### Python (matplotlib)

```python
JOURNAL_STYLES = {
    "jjyj": {  # 经济研究
        "font.family": "serif",
        "font.serif": ["Times New Roman", "SimSun", "Songti SC"],
        "font.size": 9,
        "axes.linewidth": 0.8,
        "lines.linewidth": 1.0,
    },
    "glsj": {  # 管理世界
        "font.family": "serif",
        "font.serif": ["Times New Roman", "SimSun"],
        "font.size": 9,
        "axes.linewidth": 0.8,
    },
    "jf": {
        "font.family": "serif",
        "font.serif": ["Times New Roman"],
        "font.size": 10,
        "axes.linewidth": 1.0,
        "lines.linewidth": 1.2,
    },
    "ms": {
        "font.family": "sans-serif",
        "font.sans-serif": ["Helvetica", "Arial"],
        "font.size": 10,
    },
}

import matplotlib.pyplot as plt
plt.rcParams.update(JOURNAL_STYLES["jjyj"])
```

### R (ggplot2)

```r
theme_jjyj <- function() {
  theme_classic(base_size = 9, base_family = "Times") +
    theme(text = element_text(family = "Times"),
          plot.title = element_text(size = 11),
          axis.title = element_text(size = 10),
          axis.text = element_text(size = 8),
          legend.text = element_text(size = 8))
}
```

### Stata (grstyle)

```stata
ssc install grstyle
grstyle init
grstyle set plain, nogrid    /* 经济研究风格 */
grstyle set color black gs8 gs12  /* 黑灰梯度 */
```

## 选哪种？

| 投稿目标 | 推荐 |
|---------|------|
| 《经济研究》《金融研究》《中国工业经济》 | jjyj |
| 《管理世界》《南开管理评论》《管理科学学报》 | glsj |
| JF / RFS / JFE / JFQA | jf |
| MS / JOM / SMJ | ms |
| 不确定，先求安全 | jjyj（黑白最不会出错） |

