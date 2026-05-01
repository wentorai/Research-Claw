# Mermaid 全语法速查（含中文标签）

Mermaid 是一种 markdown-native 的图表 DSL，**几乎所有现代 Markdown 渲染器**（GitHub README、Obsidian、Notion、VSCode、Typora、Logseq）都内置支持。粘贴 `.mmd` 文件内容即可即时渲染。

## 1. 图类型 keyword（首行必须）

| 关键字 | 用途 |
|--------|------|
| `flowchart TD` / `flowchart LR` | **最常用**：流程图，TD = Top-Down，LR = Left-Right |
| `graph TD` | flowchart 旧别名（兼容用） |
| `sequenceDiagram` | 交互时序图（A 调用 B，B 返回） |
| `classDiagram` | 类图（OO 设计） |
| `stateDiagram-v2` | 状态机 |
| `gitGraph` | Git 分支图 |
| `journey` | 用户旅程图 |
| `gantt` | 甘特图（项目排期） |
| `erDiagram` | 实体关系图（ER） |
| `pie title XXX` | 饼图 |
| `mindmap` | 思维导图 |

## 2. flowchart 节点形状

| 写法 | 形状 |
|------|------|
| `A[标签]` | 矩形（默认） |
| `A(标签)` | 圆角矩形 |
| `A([标签])` | 体育场（stadium） |
| `A[[标签]]` | 子流程框 |
| `A[(标签)]` | 圆柱（数据库） |
| `A((标签))` | 圆形 |
| `A>标签]` | 标签状（asymmetric） |
| `A{标签}` | 菱形（判断） |
| `A{{标签}}` | 六边形 |
| `A[/标签/]` / `A[\标签\]` | 平行四边形 |
| `A[/标签\]` / `A[\标签/]` | 梯形 |
| `A(((标签)))` | 双圆 |

## 3. 边（连线）

```
A --> B            实线箭头
A --- B            实线无箭头
A -.-> B           虚线箭头
A ==> B            粗线箭头
A --文字--> B       带文字
A -- 文字 --> B     带文字（空格风格）
A --|条件| B       带条件标签（旧）
A -->|条件| B       带条件标签（新，推荐）
A x--x B           叉号两端
A o--o B           圆头两端
```

## 4. 中文标签处理

直接写中文即可。但若标签里出现 `[`、`]`、`(`、`)`、`{`、`}` 等 Mermaid 关键字符，**必须用引号包裹**：

```
A["处理组（Treatment）"] --> B["平均处理效应 ATE"]
```

或转义：

```
A[处理组] --> B["假设 H1：β > 0"]
```

## 5. 子图（subgraph）

```
flowchart TD
    subgraph 数据层
        A[CSMAR]
        B[Wind]
    end
    subgraph 分析层
        C[Stata]
        D[Python]
    end
    A --> C
    B --> D
```

## 6. 样式 / 类

```
classDef treat fill:#fce4ec,stroke:#c2185b,stroke-width:2px;
classDef control fill:#e3f2fd,stroke:#1976d2,stroke-width:2px;
class A,B treat;
class C,D control;
```

直接给单节点上色：

```
style A fill:#fce4ec,stroke:#c2185b,stroke-width:2px
```

## 7. sequenceDiagram 速查

```
sequenceDiagram
    participant 学生
    participant 系统
    学生 ->>+ 系统: 选课请求
    系统 -->>- 学生: 选课结果
    Note over 学生,系统: 异常分支
    alt 名额已满
        系统 -->> 学生: 候补
    else
        系统 -->> 学生: 成功
    end
```

## 8. 常见坑

1. **首行必须是图类型 keyword**（`flowchart TD` 等），否则解析失败。
2. **节点 ID 必须是字母/数字**（`A1`、`node_1` 都可），中文不能做 ID，只能做标签。
3. **箭头两侧空格不严格要求**，但建议加空格便于阅读。
4. **subgraph 标题** 可以是中文，但若含特殊字符需 `subgraph "名称（含括号）"`。
5. **GitHub README** 渲染 mermaid 需把代码块标记为 ```` ```mermaid ```` 而非 ```` ```mmd ````。
6. **Notion / Obsidian** 直接支持 mermaid 代码块。
7. 想导出 PNG/SVG：用官方 CLI `mmdc -i input.mmd -o output.png`，或 https://mermaid.live/ 在线导出。

## 9. 推荐风格（论文/汇报用）

- 流程图用 `flowchart TD`，决策点用菱形 `{}`
- 因果/概念图建议用 Python TikZ，Mermaid 不擅长精确摆位
- 子图分层（数据/方法/结果）大幅提高可读性
- 中文字体在 GitHub 上渲染依赖浏览器系统字体；本地可在 mermaid.live 或 mmdc 配合 `--puppeteerConfigFile` 指定字体
