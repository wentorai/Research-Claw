# 黑白可读 + 色盲友好调色板

中文 C 刊**黑白印刷比例仍很高**，且全球约 **8% 男性、0.5% 女性**有色觉异常（多为红绿色盲）。投稿前请把图**转成灰度看一遍**。

## 1. 设计原则

> 颜色是冗余信息（redundant encoding），不是唯一信息。

意即每条数据序列、每个柱组、每个分类都用 **三重编码** 同时区分：

1. **形状 / marker / hatch 图案**（最重要）
2. **线型 / linestyle**
3. **颜色**（只是辅助）

去掉颜色，图仍可读 → 图就 OK。

## 2. 三套调色板

### 2.1 BlackWhite（首选 C 刊黑白印刷）

```python
COLORS_BW = ['#000000', '#666666', '#999999', '#CCCCCC']
LINESTYLES = ['-', '--', '-.', ':']
MARKERS = ['o', 's', '^', 'D']  # 圆 / 方 / 三角 / 菱形
HATCHES = ['', '///', '...', 'xxx']  # 柱状图填充图案
```

3–4 组以内的对比首选这套。

### 2.2 DarkGrey（首选 C 刊彩色印刷 / 网络版）

Okabe-Ito 8 色，色盲友好（保护红绿色盲、蓝黄色盲）：

```python
COLORS_OI = [
    '#000000',  # black           黑
    '#E69F00',  # orange          橙
    '#56B4E9',  # sky blue        天蓝
    '#009E73',  # bluish green    青绿
    '#F0E442',  # yellow          黄
    '#0072B2',  # blue            蓝
    '#D55E00',  # vermilion       朱红
    '#CC79A7',  # reddish purple  紫红
]
```

转灰度后（CIE Y）：

| 颜色 | 灰度值 (0–1) |
|------|-------------|
| 黑 | 0.00 |
| 蓝 | 0.21 |
| 朱红 | 0.36 |
| 紫红 | 0.46 |
| 青绿 | 0.55 |
| 橙 | 0.69 |
| 天蓝 | 0.74 |
| 黄 | 0.93 |

灰度跨度大，黑白打印仍可读。**避免相邻使用**（黄 vs. 天蓝灰度近）。

### 2.3 PaulTol Bright 6 色（彩色 / 海报）

```python
COLORS_PT = [
    '#4477AA',  # blue
    '#EE6677',  # red
    '#228833',  # green
    '#CCBB44',  # yellow
    '#66CCEE',  # cyan
    '#AA3377',  # purple
]
```

可叠加 `#BBBBBB` 灰作 baseline。

## 3. 顺序色 / 发散色（用于热图）

热图、相关矩阵、地图等连续值场景。

### 3.1 顺序色（sequential）

> 数据范围全正或全负。

- **viridis**——首选，色盲友好 + 灰度递增 + 无失真
- **cividis**——viridis 的色盲优化版本，最严格的色盲友好
- **gray / Greys**——黑白印刷场景

**禁用**：`jet` / `rainbow` / `hsv`——彩虹色阶在科学可视化是众矢之的，灰度不单调。

### 3.2 发散色（diverging）

> 数据有自然中点（如 0、相关系数）。

- **RdBu_r**（红蓝反转）——经典选择
- **PuOr**（紫橙）——色盲友好
- **BrBG**（棕青绿）——更色盲友好

热图务必：

- 设 `vmin = -vmax` 让中点对齐 0
- 选发散色阶
- 显示 colorbar 并标注中点

## 4. 黑白安全自检清单

绘图后做以下检查：

- [ ] 把 PDF 打印出来或导出灰度 PNG，每条线 / 每组柱仍可区分
- [ ] 用色盲模拟器（Coblis / Chromatic Vision Simulator）查看，红绿仍可区分
- [ ] 关键标记（处理组 vs. 对照组）使用 marker 而非仅颜色
- [ ] 柱状图启用 hatch 填充
- [ ] 系数图的不同模型用不同 marker 形状

## 5. matplotlib 灰度预览

```python
from matplotlib.colors import rgb_to_hsv, to_rgba
import numpy as np
def to_gray(hexc):
    r, g, b, _ = to_rgba(hexc)
    # CIE Y luminance
    return 0.2126*r + 0.7152*g + 0.0722*b
print([(c, round(to_gray(c), 2)) for c in COLORS_OI])
```

或一行命令导出灰度 PDF 验证：

```python
import matplotlib.pyplot as plt
plt.style.use('grayscale')   # 临时切到灰度风格
# ... plot ...
fig.savefig('fig_gray_check.pdf')
```

## 6. 柱状图 hatch 填充

```python
ax.bar(x, y1, color='#FFFFFF', edgecolor='black', hatch='', label='对照')
ax.bar(x, y2, color='#FFFFFF', edgecolor='black', hatch='///', label='处理')
ax.bar(x, y3, color='#999999', edgecolor='black', hatch='', label='安慰剂')
```

可用 hatch：`/` `\` `|` `-` `+` `x` `o` `O` `.` `*`，可叠加 `///` 加密。

## 7. 期刊倾向速查

| 期刊语言 | 印刷 | 推荐配色 |
|---------|------|---------|
| 中文 C 刊（《经济研究》《金融研究》等） | 多为黑白 | BlackWhite + hatch |
| 中文 C 刊（《管理世界》部分） | 彩色 | Okabe-Ito |
| 心理学报 / 教育学报 | 黑白为主 | BlackWhite |
| 网络版 / 工作论文 | 彩色 | Okabe-Ito 或 Paul Tol |

不确定 → **永远从 BlackWhite 开始**。
