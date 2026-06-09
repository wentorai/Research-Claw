# 申请书摘要 + 关键词撰写 Prompt

> 用途：起草 / 重写 NSFC 申请书的"摘要"（中文 ≤ 400 字）+ 关键词（5-7 个）。

摘要是**评审专家最先看到、决定 60 秒分类（推荐 / 待定 / 边缘 / 毙）的章节**。基金委公开建议"摘要应最后写"——因为只有所有章节定稿后，才能精准凝练出 4-5 句"做什么 / 为什么重要 / 怎么做 / 期望什么"。

---

## 一、摘要的标准结构（5 句法）

NSFC 公开建议的摘要标准为 **400 字以内 + 5-7 句话**，按以下 **5 句法** 组织：

| 句 | 内容 | 示例句式 |
| --- | --- | --- |
| **句 1** | **领域 + 重要性**（W1：做什么；W2：为什么重要） | "X 是 Y 学科 / Z 应用领域的核心问题。理解 X 的 …… 对 …… 具有重要意义。" |
| **句 2** | **科学问题 / 缺口**（已有研究的不足） | "已有研究虽 ……，但在 …… 方面仍存在 …… 缺口（其根本原因在于 ……）。" |
| **句 3** | **本项目的核心切入点 / 创新假说** | "本项目针对该缺口，**首次提出 …… 假说 / 框架（命名 X-Y）**，将 …… 重构为 ……。" |
| **句 4** | **研究内容 / 方法**（用 1 句话概括 R1-R5） | "围绕 X-Y 假说，本项目将开展 (1) 理论 ……、(2) 实证 ……、(3) 应用 …… 三方面研究。" |
| **句 5** | **预期成果 + 学术意义** | "预期成果将为 …… 提供新的 ……，并对 ……（学术 + 应用 / 国家需求）具有重要意义。" |

### 1.1 各句字数建议

- 句 1：50-80 字（领域 + 重要性）
- 句 2：50-80 字（科学问题 / 缺口）
- 句 3：60-100 字（核心切入点 / 创新假说，**最长**）
- 句 4：80-120 字（研究内容）
- 句 5：50-80 字（预期成果 + 意义）
- **总计：290-460 字**——目标在 350-400 字

### 1.2 不同学科的微调

| 学科 | 摘要必有 | 摘要避免 |
| --- | --- | --- |
| 数理 (A) | 数学 / 物理问题陈述、关键定理 / 关键预测 | 应用导向的"国家需求" |
| 化学 (B) | 反应 / 路线 / 机理 | "国际领先 / 填补空白" |
| 生命 (C) | 表型 / 机制 / 调控 | "全面 / 系统" |
| 地球 (D) | 时空尺度 + 数据 / 模型 / 验证 | 缺野外 / 卫星证据 |
| 工材 (E) | 物理机制 + 工程价值 | 仅参数 sweep |
| 信息 (F) | SOTA 对比 + 可量化指标 | "我们提出 ……"（不写具体提升幅度） |
| 管理 (G) | 因果识别 + 中国情境 | 缺识别策略 |
| 医学 (H) | 机制 + 转化 + 预实验 | "首次研究" |
| 交叉 (T) | 真交叉的科学问题 | 拼凑（"用 A 方法做 B 问题"） |

---

## 二、关键词（5-7 个）的写法

### 2.1 关键词的作用

- **代码派送**：NSFC 系统按"二级 / 三级代码 + 关键词"匹配函评专家
- **检索**：项目立项后会进入 NSFC 项目数据库

### 2.2 关键词层级建议（覆盖 3 层）

5-7 个关键词，建议按以下层级覆盖：

| 层 | 数量 | 例子（G02 工商管理 / 数字平台方向） |
| --- | --- | --- |
| **L1：领域 / 主题** | 2 个 | 数字平台、双边市场 |
| **L2：方法 / 框架** | 2 个 | 因果识别、动态权衡 |
| **L3：应用 / 数据 / 概念** | 2-3 个 | 用户黏性陷阱、平台治理、外部冲击 |

### 2.3 反面例子

> **劣**：研究、方法、机制、影响、应用（5 个空泛词）

**为什么劣**：5 个词都没"领域 / 流派 / 方法学"指向，函评派送会随机化。

> **优**：动态注意力路由、视觉 Transformer、强化学习路由、边缘计算、ImageNet 推理（F02 信息工程示例）

---

## 三、英文摘要 (Abstract) 写法

NSFC 申请书要求中英文摘要各 1 份。英文摘要 **不是中文摘要的逐字翻译**——可以适当结构化、句式更直白。

### 3.1 英文摘要"5 句法"模板

```
[Sentence 1: Field + significance]
X is a fundamental issue in field Y. Understanding the …… of X is crucial for …… (academic / national need).

[Sentence 2: Gap]
Although prior work has substantially advanced our understanding of A, an important gap remains in B, primarily due to ……

[Sentence 3: Proposal + naming]
This project addresses this gap by proposing the **{Concept Name}** framework / hypothesis, which reframes …… as ……

[Sentence 4: Content]
We will conduct three lines of research: (1) ……; (2) ……; (3) …….

[Sentence 5: Outcome + significance]
The expected outcomes will provide a new theoretical / methodological / empirical foundation for ……, with substantial implications for both …… and ……
```

### 3.2 英文摘要禁忌

- **"This project will systematically / comprehensively study ……"** —— 评审最反感
- **"We will fill the gap of ……"** —— 自我评价
- **被动语态全篇** —— 推荐主动语态（"We propose ……", "This project addresses ……"）
- **缩写不解释** —— 第一次出现必须给全称

---

## 四、Prompt 模板（用于 Claude / 其他 LLM）

```
你是 NSFC 申请书写作助手。请帮我撰写「摘要」（中文 ≤ 400 字）+「英文摘要」+「关键词」（5-7 个，含中英文）。

【已有信息】
- 项目类别：{{面上 / 青年 / 重点 / 杰青 / 优青 / 国合 / 重大研究计划}}
- 申请代码：{{学部代码，如 G0301}}
- 研究主题：{{一句话主题}}
- 关键科学问题 KP1-KPm：{{……}}
- 研究内容 R1-Rn：{{……}}
- 项目级标志性概念 / 假说命名（如有）：{{……}}
- 预期成果：{{……}}

【写作要求】

## 中文摘要（≤ 400 字，5 句法）
- 句 1（50-80 字）：领域 + 重要性
- 句 2（50-80 字）：科学问题 / 缺口（已有研究不足）
- 句 3（60-100 字）：本项目的核心切入点 / 创新假说，**含项目级命名**
- 句 4（80-120 字）：研究内容（用 1 句话概括 R1-Rn）
- 句 5（50-80 字）：预期成果 + 学术意义

## 英文摘要（200-300 words）
按 5 句法对应翻译，但允许结构化、可加 (1)(2)(3) 编号

## 关键词（5-7 个，中英对照，按以下 3 层覆盖）
- L1（2 个）：领域 / 主题
- L2（2 个）：方法 / 框架
- L3（2-3 个）：应用 / 数据 / 概念

【自检清单】
- [ ] 中文摘要 ≤ 400 字、≥ 280 字
- [ ] 句 1 前两句答出"做什么 + 为什么重要"
- [ ] 句 3 是否含"项目级命名 / 假说 / 框架名"？
- [ ] 是否避免"首次 / 系统性 / 全面 / 国际领先"等空泛词？
- [ ] 英文摘要主动语态、缩写有全称
- [ ] 关键词覆盖 3 层
- [ ] 关键词中英文一致

请先输出"句 1 + 句 3"两句草案，等我确认后再展开完整摘要。
```

---

## 五、Worked Example（G02 工商管理 / 数字平台方向）

### 中文摘要（约 380 字）

> 数字平台已成为中国数字经济的核心基础设施，理解其市场结构与竞争机制对优化平台治理、防范"赢者通吃"具有重要意义。然而，已有研究多将"用户黏性"视为平台的正向资产，对其在双边市场中的"双面性"认识不足，无法解释部分高黏性平台在跨边外溢时反而表现疲软的悖论。本项目针对这一缺口，**首次提出"用户黏性陷阱 (Stickiness Trap, ST) 假说"**，将单边黏性与跨边外溢的关系重构为动态权衡问题。围绕该假说，本项目将开展三方面研究：（R1）构建黏性—外溢动态权衡的理论模型；（R2）使用平台外生 IPO 冲击作为识别工具进行因果识别；（R3）模拟政策情境的反事实评估。预期成果将为平台治理与反垄断政策提供新的理论与实证基础，对中国数字经济高质量发展具有重要参考意义。

### 英文摘要（约 250 词）

> Digital platforms have become the core infrastructure of China's digital economy. Understanding their market structure and competitive mechanisms is crucial for optimizing platform governance and preventing winner-takes-all outcomes. However, existing research largely treats "user stickiness" as a positive asset, and is insufficient in recognizing its dual nature in two-sided markets — failing to explain why some high-stickiness platforms show weak performance in cross-side spillovers. This project addresses this gap by proposing the **Stickiness Trap (ST) Hypothesis**, which reframes the relationship between single-side stickiness and cross-side spillover as a dynamic trade-off problem. Building on this hypothesis, we will conduct three lines of research: (1) constructing a theoretical model of the stickiness-spillover dynamic trade-off; (2) identifying causal effects using exogenous platform IPO shocks as identification instruments; and (3) simulating counterfactual policy scenarios. Expected outcomes will provide new theoretical and empirical foundations for platform governance and antitrust policy, with substantial implications for the high-quality development of China's digital economy.

### 关键词

- **中文**：数字平台、双边市场、用户黏性陷阱、因果识别、平台治理、跨边外溢、反垄断
- **English**: Digital platforms; Two-sided markets; Stickiness trap; Causal identification; Platform governance; Cross-side spillover; Antitrust

---

## 六、注意事项

- 摘要是**评审专家最先看到的章节**——前 2 句决定本子能否进入"推荐"文件夹
- 但摘要应**最后写**——只有所有章节定稿后才能精准凝练
- 中文摘要 400 字是**硬上限**（NSFC 系统会截断），写到 380-395 字最稳妥
- 英文摘要建议 200-300 words；不必逐字翻译
- 关键词的"代码派送"作用至关重要——5-7 个词覆盖 3 层
- 不同学科有微调（详见上文 1.2 节）
- 最终请以当年 ISIS 系统模板为准
