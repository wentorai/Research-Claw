# PRISMA 2020 流程图规范

PRISMA = **P**referred **R**eporting **I**tems for **S**ystematic reviews and **M**eta-**A**nalyses。2020 年版（Page et al., 2021, *BMJ*）取代 2009 版，是医学/心理学/教育学/管理学**所有系统综述论文几乎强制要求**的报告标准。

官方网站：http://www.prisma-statement.org/

## 1. 流程图四阶段

```
Identification 识别 → Screening 筛选 → Eligibility 合格性 → Included 纳入
```

PRISMA 2020 把 Eligibility 与 Screening 合并讲，但视觉上仍可分四层。

### 阶段 1：Identification（识别）

- 数据库检索得到的文献数（按数据库分别报告）：`PubMed (n=...), Web of Science (n=...), Scopus (n=...)`
- 其他来源（registers、引文追踪、机构存储）：`(n=...)`
- 去重前合计：`(n=...)`
- **去重后**：`(n=...)`（关键节点）

### 阶段 2：Screening（筛选）

- 基于标题/摘要筛选 → 排除（说明原因 + 数量）
  - `Excluded by title/abstract (n=...)`
- 进入全文复核：`(n=...)`
- 全文未获取：`(n=...)`，要写明原因（订阅/语种/作者无回应）

### 阶段 3：Eligibility（合格性）

- 全文复核数：`(n=...)`
- 全文复核排除（**必须按原因分组**）：
  - 不符合人群 (n=...)
  - 不符合干预 (n=...)
  - 不符合结果 (n=...)
  - 研究设计不符 (n=...)
  - 重复发表 (n=...)
  - 数据不可用 (n=...)
  - 语种限制 (n=...)

### 阶段 4：Included（纳入）

- 纳入定性综述：`(n=...)`
- 纳入 meta-analysis（若有）：`(n=...)`

## 2. 标准方框配色

PRISMA 官方未强制配色，但社区惯例：

| 阶段 | 颜色 | 说明 |
|------|------|------|
| Identification | 浅蓝 `#cfe8fc` | 数据来源 |
| Screening | 浅黄 `#fff3c4` | 筛选过滤 |
| Eligibility | 浅橙 `#ffd9b3` | 全文核查 |
| Included | 浅绿 `#c8e6c9` | 最终纳入 |
| Excluded | 浅红 `#ffcdd2` | 排除分支 |

## 3. 视觉布局约定

```
┌──────────────────────────────┐
│  Identification              │   ← 顶部一层（可分多个数据库框）
└──────────┬───────────────────┘
           │
┌──────────▼───────────────────┐    ┌────────────┐
│  Records after duplicates    │ ─→ │  Excluded  │  ← 右侧分支
└──────────┬───────────────────┘    └────────────┘
           ...
```

主流是**单列直线 + 右侧排除分支**，每一步都标 `n=` 数字。

## 4. PRISMA 2020 vs 2009 关键差异

| 项目 | 2009 | 2020 |
|------|------|------|
| Records identified through database | 一个总数 | **每个数据库分别报告** |
| Records identified through other sources | "Other sources" | 分为 `Registers` 与 `Other methods` 两类 |
| Reasons for exclusion at full-text | 可选 | **强制按原因分组报告** |
| Updated review | 不区分 | 提供 *update* 模板（区分 previous vs new records） |

## 5. Python 实现要点

`templates/python/prisma_flow_matplotlib.py`：
- 不依赖 Graphviz，纯 matplotlib `Rectangle` + `FancyArrowPatch`
- 每个方框 `(x, y, w, h, label, color)` 五元组
- 主流 + 排除分支双栏布局
- 字体 fallback：`SimSun / Songti SC / Source Han Serif SC / Times New Roman`
- 默认输出 PDF + PNG，DPI=300

## 6. Mermaid 实现要点

`templates/mermaid/prisma-flow.mmd`：
- 用 `flowchart TD` + `subgraph` 分四阶段
- 排除分支用 `-->|exclude|` 右侧节点
- 中文标签直接写

## 7. 检查清单

- [ ] 所有方框都标 `n = X` 数字（不能为空）
- [ ] Identification 阶段按**数据库**分别报告
- [ ] 全文排除分**至少 5 类原因**报告
- [ ] 区分 records 与 reports（一个 record 可能有多份 reports）
- [ ] 提供 `Included in qualitative synthesis` 与 `Included in meta-analysis` 两行
- [ ] 文件名含 `prisma-2020` 字样以示版本
