# Common Chart Mistakes

This reference provides conservative defaults. Treat journal-specific author instructions as authoritative when available.

经管学者绘图常犯错清单：收录国内经管学者论文中**最容易被审稿人挑错**的图表问题。

---

## 1. 多回归出表不出图

**症状**：第 5 节"基准回归"只放一个 `outreg2` / `estout` 表，6 列回归密密麻麻。

**为什么不好**：
- 审稿人扫表 5 秒看不到核心系数变化
- 顶刊审稿人**强烈倾向系数图**

**改法**：保留 6 列回归表为表 5；同时画一张 coefplot：横轴模型名，纵轴 X 系数 + 95% CI；表给细节，图给信息。

---

## 2. 事件研究图基期未归零

**症状**：DiD 事件研究图，t = -4 到 t = +5 全部是估计点，没有特殊处理 t = -1。

**为什么不好**：数学上不可识别（缺一个基期）；平行趋势检验失去 anchor。

**改法**：必须把某一期（通常 t = -1）归 0；用空心圆 / 不画 CI 来标识；文字注明"以 t = -1 为基期"。

---

## 3. Pre-trend 显著但默认图就这么放

**症状**：事件研究图 t = -3 处的系数已经显著为正。

**审稿人会说**：你这不是政策效应，是趋势回归。

**改法**：必须直面：报告 pre-trend test p-value；提供事前 placebo 检验；用 Borusyak / Sun-Abraham / Callaway-Sant'Anna 修正异质性偏误后再画。

---

## 4. 双纵轴乱用

**症状**：左轴是"GDP 增速"右轴是"CPI"，两条线交叉处号称"相关"。

**为什么不好**：双轴比例尺人为选择，可任意制造视觉相关；AAA / AER / Nature 等顶刊**禁止双轴**除非单位真同源。

**改法**：改用两个 panel（subplots）；或标准化到 z-score 后单轴；或只画散点 + 拟合。

---

## 5. 中文字体未设，图里方块乱码

**症状**：matplotlib 默认图，中文标签全是 □ □ □。

**改法**（matplotlib）：

```python
plt.rcParams["font.family"] = "serif"
plt.rcParams["font.serif"] = ["Times New Roman", "SimSun", "Songti SC",
                              "Source Han Serif SC", "STSong", "Noto Serif CJK SC"]
plt.rcParams["axes.unicode_minus"] = False
```

---

## 6. 颜色用了 matplotlib 默认 tab10

**症状**：图里五颜六色蓝橙绿红紫，浮夸。

**改法**：中文期刊用灰度梯度 `["#000000", "#595959", "#A6A6A6", "#D9D9D9"]`；JF / RFS 用蓝灰系；MS 可以 viridis。

---

## 7. 标签英文（图里写 "Treatment Effect"）

**症状**：投中文期刊但图标签全英文。

**为什么不好**：审稿人会写"图表标签请改为中文"——多一轮 R&R 浪费 2 个月。

**改法**：直接全中文。"处理效应估计""政策实施年份""95% 置信区间"。

---

## 8. 处理组地图忘配图例

**症状**：DiD 处理组地图，浅蓝深蓝两种颜色，但**没说哪个是处理组**。

**改法**：必须有 legend，"■ 处理组（试点城市）"  "□ 控制组"；政策开始时间也要标在图标题或图注。

---

## 9. Sankey 节点过多

**症状**：30 个上市公司 → 30 家关联方，画出来一团乱麻。

**改法**：节点 ≤ 12（左右各最多 6）；超过则按行业 / 地区聚合；或用网络图代替。

---

## 10. Bin scatter 没说分箱数

**症状**：图里只画散点 + 拟合线，未注明 bin 数。

**改法**：图注必须写"按 X 等距分为 25 箱""分箱数 = 50（基于 IMSE 最优）"。

---

## 11. 系数图没画 0 参考线

**症状**：coefplot 横向画了 6 个系数 + CI，但没有 x = 0 的参考线。

**改法**：`xline(0, lcolor(gs8) lpattern(dash))`（Stata） / `geom_vline(xintercept = 0, linetype = "dashed")`（ggplot2）。

---

## 12. 字号 12 pt 默认

**症状**：matplotlib / ggplot2 默认 12pt，单栏图缩到 8.5cm 后字糊成一片。

**改法**：单栏图字号 8–9 pt，双栏 9–10 pt。

---

## 13. PNG / JPG 投稿

**症状**：PDF 论文里嵌的图是 PNG，放大就糊。

**改法**：matplotlib `savefig("fig.pdf")`；ggplot2 `ggsave("fig.pdf")`；Stata `graph export "fig.pdf", as(pdf)`。

---

## 14. 多面板图各 panel 字号不一

**症状**：4 个 subplot，有的字号 8 有的 11，看起来 panel 大小都"自动放缩"。

**改法**：统一 rcParams；如果某 panel 字小，要么删要么加大整图尺寸。

---

## 15. 处理时点没竖线

**症状**：事件研究 / 时间序列图，政策实施时点没有标记。

**改法**：`axvline(x=0, ls=":", color="gray", lw=0.6)`；政策事件加文字注释"2017 年试点"。

---

## 16. 网络图节点大小不可比

**症状**：节点大小没有统一映射（degree centrality / betweenness）。

**改法**：必须告诉读者"节点大小 = degree centrality"，并给图例。

---

## 17. 森林图缺汇总效应

**症状**：列了 12 个研究的 OR + CI，但没有底部 summary diamond。

**改法**：必须有 random / fixed effect 汇总；加 I² 异质性指标。

---

## 18. 颜色深浅没有顺序

**症状**：年度颜色 2015 = 深红 / 2016 = 浅蓝 / 2017 = 深绿，无序。

**改法**：时序数据用顺序色谱 viridis / cividis；年度从浅到深。

---

## 19. 图注 / 数据来源缺失

**症状**：图下没有"注：……数据来源：……"。

**改法**：注：变量含义、估计方法、显著性符号；数据来源：CSMAR / Wind / 国家统计局，并写入访问年份。

---

## 20. 双柱状图重叠区域处理不当

**症状**：两组柱重叠（用 alpha = 0.5），看不清。

**改法**：并排（dodge）而不是重叠；或用差分柱（"处理 - 控制"）；或拆 panel。

