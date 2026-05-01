# 假设关系树（Hypothesis Tree）规范

管理学 / 经济学 / 心理学 / 营销 论文的"理论与假设"小节通常会列出 **H1, H2, H3 ...**，子假设 **H1a, H1b**，并在概念模型图中表达调节（Moderator）/ 中介（Mediator）关系。本规范给出标准画法。

## 1. 三种典型结构

### 1.1 平行假设

```
研究问题 → H1: A → B
         → H2: C → D
         → H3: E → F
```

每个假设独立。常见于探索性研究。

### 1.2 主-辅假设（H1 + H1a/H1b 子假设）

```
研究问题 → H1: 自变量 X → 因变量 Y
              ├─ H1a: X 正向影响 Y 的某分量 Y1
              └─ H1b: X 负向影响 Y 的另一分量 Y2
         → H2: 调节变量 Z 强化 X→Y 的关系
```

主流写法：H1 是"总效应"，H1a / H1b 拆"分维度"。

### 1.3 中介-调节组合（最常见，发 SSCI top）

```
                  M (中介)
                ↗   ↓
           X ──────→ Y
                ↑
                W (调节，调 X→Y 路径)
```

- H1: X → Y 直接效应（main effect）
- H2: X → M → Y 中介效应（M 解释 why）
- H3: W 调节 X→Y（W 决定 when / for whom）
- H4: W 调节 X→M→Y 的中介效应（moderated mediation）

## 2. 视觉规范

| 元素 | 推荐画法 |
|------|---------|
| 自变量 X | 矩形，浅蓝 `#cfe8fc` |
| 因变量 Y | 矩形，浅绿 `#c8e6c9` |
| 中介 M | 椭圆，浅黄 `#fff8c4` |
| 调节 W | 菱形，浅紫 `#e1bee7` |
| 假设标签 | 沿箭头加 `H1 (+)` / `H2 (−)` 标符号方向 |
| 显著性 | `***` `**` `*` 不写在概念图，写在结果表 |

## 3. 假设书写公式（LaTeX 友好）

```
H1: X 与 Y 之间存在显著正相关。
    H1: β_{X→Y} > 0.
H2: M 中介 X 对 Y 的影响。
    H2: β_{X→M} \cdot β_{M→Y} \neq 0 (Sobel/bootstrap test).
H3: W 调节 X 对 Y 的影响。
    H3: β_{X×W → Y} \neq 0.
H4: W 调节 X 通过 M 对 Y 的间接效应。
    H4 (moderated mediation): index of moderated mediation \neq 0.
```

## 4. 常见坑

1. **方向错配**：H1 假设 "正向"，但模型估计出来负显著，论文要么改假设、要么解释（不能装作没看到）。
2. **假设过多**：3–5 个为佳；> 7 个就该砍。
3. **子假设互斥**：H1a 与 H1b 应能同时成立或不成立，不要写互相矛盾。
4. **主效应缺失却谈中介**：必须先确认 X→Y 显著，再讨论中介（Baron-Kenny；现代 PROCESS 不强制但 Reviewer 仍看重）。
5. **moderated mediation** 必须报 *index of moderated mediation*（Hayes, 2015）+ bootstrap CI。

## 5. 假设关系树 Python 实现

`templates/python/hypothesis_tree.py`：
- 用 `networkx.DiGraph` 建立 H1, H2, H3, H1a, H1b 节点
- `nx.draw` 配合手动 layout：研究问题在顶部，主假设在第二层，子假设在第三层
- 假设强度用边粗细表达
- 支持中文 + 数学符号

## 6. Mermaid 实现

`templates/mermaid/theoretical-framework.mmd` 给出含调节中介的完整框架：

```
flowchart LR
    X[自变量 X] -- "H1 (+)" --> Y[因变量 Y]
    X -- "H2a" --> M((中介 M))
    M -- "H2b" --> Y
    W{调节 W} -. "H3" .-> linkX_Y
```

注意 Mermaid 不直接支持"指向边"，调节关系常用虚线 `-.->` 表达。

## 7. 推荐流程

1. 先在草稿纸列假设清单（H1...Hn + 方向 + 系数符号）
2. 用 Mermaid 快速画出概念模型
3. 反复对照"主效应 / 中介 / 调节"是否覆盖完整
4. 投稿前换成 TikZ 或 Python 高分辨率图
5. 文中**每个假设**都要在结果章节给出对应表格行（H1 → Table 3, Column 2）
