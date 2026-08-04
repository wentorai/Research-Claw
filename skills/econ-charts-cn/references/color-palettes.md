# Color Palettes

This reference provides conservative defaults. Treat journal-specific author instructions as authoritative when available.

经管研究色板：黑白 / 灰度（B&W）、政策评估类、金融市场类，附 hex 码、使用场景与反例。

---

## 1. 黑白 / 灰度（B&W）系列

适用于：所有中文期刊、印刷优先的论文、需 100% 色盲友好的场景。

### 1.1 4 色灰度梯度（最稳）

```
黑   #000000
深灰 #595959
中灰 #A6A6A6
浅灰 #D9D9D9
```

用法：4 组类别，按重要性递减用深→浅。**永远配 marker 区分**。

### 1.2 5 色灰度梯度（极限）

```
#000000  #404040  #7F7F7F  #BFBFBF  #E6E6E6
```

5 组以上不要用纯灰度，用 marker / linestyle / hatch 替代。

### 1.3 灰度 + 一抹高亮

主线条用灰度，关键一组用黑色或一抹深蓝：

```
背景   #BFBFBF
次要   #595959
主要   #000000
高亮   #08306B
```

---

## 2. 政策评估类（Policy Evaluation）

适用于：DiD / 处理组 vs 控制组 / 政策前后对比图。

### 2.1 处理组 vs 控制组（推荐）

```
处理组 #08306B   (深海蓝)
控制组 #A6A6A6   (中灰)
```

**为何不用红绿**：色盲（约 8% 男性）无法区分；中文语境红绿带政治含义。

### 2.2 政策时点强调

```
处理组   #08306B
控制组   #A6A6A6
政策线   #C6111E   (砖红)
0 参考  #7F7F7F   (灰虚线)
```

### 2.3 三组对比（多重处理）

```
强处理组 #08306B
弱处理组 #4292C6
控制组   #A6A6A6
```

---

## 3. 金融市场类（Financial Markets）

适用于：股票收益 / 风险因子 / 行业分类等。

### 3.1 长短仓 / 多空

```
多头   #C6111E   (砖红)
空头   #08306B   (深蓝)
```

或保守版（中文期刊优先）：

```
多头   #404040
空头   #BFBFBF
```

### 3.2 行业分类（10 行业）

ColorBrewer Set3 或 viridis 离散 10 色：

```
#1F3864 #2E75B6 #5B9BD5 #9DC3E6
#A9D18E #70AD47 #C6111E #ED7D31
#7030A0 #404040
```

### 3.3 按时序渐变（年度 / 月度）

cividis / viridis 顺序色谱：

```
#00204D #2C3E78 #5C4F8F #8A60A0 #C870A8 #FFA09E
```

---

## 4. 期刊偏好速查

| 期刊 | 推荐色板 |
|------|---------|
| 《经济研究》 | 1.1 / 1.2 灰度 |
| 《管理世界》 | 1.3 灰度+高亮 / 2.1 |
| 《金融研究》 | 1.1 / 1.3 |
| Journal of Finance | 2.1 / 3.1 |
| Review of Financial Studies | 2.1 / 3.2 |
| Management Science | viridis / 3.2 |
| 《会计研究》 | 1.1 |

---

## 5. matplotlib / R / Stata 三语言赋值

### Python

```python
PALETTES = {
    "bw4":     ["#000000", "#595959", "#A6A6A6", "#D9D9D9"],
    "policy":  ["#08306B", "#A6A6A6"],
    "policy3": ["#08306B", "#4292C6", "#A6A6A6"],
    "finance": ["#C6111E", "#08306B"],
}
import matplotlib.pyplot as plt
plt.rcParams["axes.prop_cycle"] = plt.cycler(color=PALETTES["bw4"])
```

### R (ggplot2)

```r
pal_bw4    <- c("#000000", "#595959", "#A6A6A6", "#D9D9D9")
pal_policy <- c(treat = "#08306B", control = "#A6A6A6")
ggplot(...) + scale_color_manual(values = pal_policy)
```

### Stata

```stata
grstyle set color "0 0 0" "89 89 89" "166 166 166" "217 217 217"
```

---

## 6. 反例 / 不要用

- matplotlib 默认 tab10：太花、不黑白友好
- 红绿对比（即使是经典涨跌色）：色盲杀手
- rainbow / jet：信息无序、伪 3D 错觉
- 纯白背景上画浅黄：印刷出来根本看不见
- 超过 6 种类别还想用颜色区分：换图（用面板 or 用线型 hatch）

## 7. 黑白可读自查

打印一张草图，开关复印机的"黑白"模式。如果**任何两组无法区分**，颜色就不合格。

