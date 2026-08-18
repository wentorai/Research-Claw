# 因果 DAG 视觉规范（DAGitty 兼容）

因果有向无环图（DAG）是 Pearl-style 因果推断 / 流行病学 / 经济学 / 社会学论文中最重要的可视化之一。本规范综合 [DAGitty](http://dagitty.net/) 工具的视觉惯例，给出团队内可统一沿用的规则。

## 1. 节点角色与配色

| 角色 | 含义 | 推荐颜色 / 形状 | 说明 |
|------|------|------------------|------|
| Treatment / Exposure | 处理变量 (T, X) | 圆形 / 浅红 `#fce4ec` 边 `#c2185b` | 加 "▶" 或边框加粗 |
| Outcome | 结果变量 (Y) | 圆形 / 浅蓝 `#e3f2fd` 边 `#1976d2` | 双圈或粗边 |
| Confounder | 混杂变量 (W) | 圆形 / 浅黄 `#fff8e1` 边 `#f57f17` | DAGitty 用蓝色 |
| Mediator | 中介变量 (M) | 椭圆 / 浅绿 `#e8f5e9` 边 `#2e7d32` | 通常处于 T 与 Y 之间 |
| Moderator | 调节变量 | 菱形 / 浅紫 `#f3e5f5` 边 `#6a1b9a` | 表示 T→Y 关系强度依 W 变化 |
| Instrument (IV) | 工具变量 (Z) | 圆形 / 浅灰 `#f5f5f5` 边 `#424242` | 满足 Z→T、Z⊥Y given T、Z⊥U |
| Unobserved | 不可观测 (U) | 虚线圆 / 灰色 | DAGitty 标记为带圈的 U |
| Selection / Collider | 对撞 / 选择 | 方框 / 红色 边 | 标 "C" 或在边上画 [conditioned] |

## 2. 边（关系）类型

| 视觉 | 含义 |
|------|------|
| 实线箭头 → | 因果方向（结构方程） |
| 虚线 ↔ | 共同原因（双箭头表示存在未观测共同 cause） |
| 粗线 / 红线 | 焦点（处理→结果）路径 |
| 灰线 | 背景/控制变量产生的 nuisance 路径 |
| 加方框 [W] | 表示 W 已被控制（conditioning on W） |

## 3. DAGitty 兼容文本格式（dagitty syntax）

DAGitty 接受紧凑的纯文本输入：

```
dag {
  bb="0,0,1,1"
  T [exposure,pos="0.2,0.5"]
  Y [outcome,pos="0.8,0.5"]
  W [pos="0.5,0.2"]
  M [pos="0.5,0.5"]
  U [latent,pos="0.5,0.8"]
  T -> M -> Y
  W -> T
  W -> Y
  U -> T
  U -> Y
}
```

`pos` 用归一化坐标 (0,0) 左下到 (1,1) 右上。我们的 Python 模板把 `pos` 映射到 matplotlib 坐标。

## 4. 论文里画 DAG 的检查清单

- [ ] 处理变量 T、结果变量 Y 一目了然（颜色 / 加粗）
- [ ] 已控制变量 W 用方框包裹或标 `[adjusted]`
- [ ] 不可观测 U 用虚线圈
- [ ] 工具变量 Z 单独标注，且只与 T 相连（Z⊬Y）
- [ ] 中介 M 在 T→Y 的路径上（discuss whether to control）
- [ ] 没有有向环（DAG = Directed **Acyclic** Graph）
- [ ] 全部箭头方向一致表达因果时序（左→右 或 上→下）

## 5. 5 种识别策略对应的最小 DAG

| 策略 | 关键节点 | DAG 结构 |
|------|---------|----------|
| **OLS / 控制混杂** | T, Y, W | `W→T, W→Y, T→Y`，控制 W |
| **IV** | Z, T, Y, U | `Z→T, T→Y, U→T, U→Y`；Z 与 U 无连 |
| **DiD** | T, Y, time, unit FE | 加固定效应 = 控制 unit-level U_i 与 time-level U_t |
| **RDD** | running var R, T, Y | `R→T (deterministic at cutoff), R→Y, T→Y` |
| **Mediation** | T, M, Y | `T→M→Y` + 直接路径 `T→Y` |

## 6. Python 模板使用

`templates/python/causal_dag_dagitty.py` 实现：
- 用 `networkx.DiGraph` 存因果结构
- 节点角色映射到颜色/形状（基于上表）
- `nx.draw_networkx_*` 一次画完
- 输出 PDF（论文用）+ PNG（汇报用）

## 7. TikZ 模板使用

`templates/tikz/causal_dag.tex` 用 `\usepackage{tikz}` + `\usetikzlibrary{positioning,arrows.meta}`，定义节点样式 `treat / outcome / conf / latent`，可一行调换名字。

## 8. 常见错误

1. **画环**：T→W→T 出现就是结构方程错了；DAG 要求 acyclic。
2. **混淆中介与混杂**：W 在 T 之前是混杂；M 在 T 之后是中介。控制策略相反！
3. **conditioning on collider**：在对撞节点上控制会引入选择偏差，DAG 上要明确标记。
4. **不画 unobserved**：写论文时把 U 画虚线圈，让审稿人一眼看到识别假设。
