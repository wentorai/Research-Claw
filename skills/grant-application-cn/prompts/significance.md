# Prompt: 重要性 / 立项依据 / Significance 撰写

## 用途
帮助用户撰写各类项目"重要性"段落，统一回答 **"so what"**，但按目标项目体例呈现。

## 项目体例映射

| 项目 | Section 名 | 篇幅指引 |
|------|-----------|---------|
| 国家社科基金 | "选题依据"中的"研究意义" | 占活页约 1/4，~1500-2500 字 |
| 教育部人文社科 | "选题意义" | ~1000-2000 字 |
| NIH R01 | Significance（在 Research Strategy 内） | 2-3 pages |
| NSF | Intellectual Merit + Project Description 的 introduction | 1-2 pages |
| ERC | Extended Synopsis 第 1 段 + B2 状态艺术 | 0.5-1 page synopsis 内 |
| MSCA PF | Excellence section 第 1 段 | ~1 page |

## 输入要求

询问用户：
1. **目标项目类型**（决定体例）
2. **研究问题**（≤ 50 字）
3. **本研究服务的真问题**（疾病负担 / 政策痛点 / 学科 gap / 国家战略）
4. **本研究的拟突破点**（与现有文献相比能 contribute 什么）
5. **拟引用的关键文献**（≥ 5 条 DOI / 引文条目，否则提醒用户先做文献调研）

## 通用结构（统一回答 5 个问题）

无论目标项目体例，"重要性"段落本质上回答 5 个问题：

1. **Why this topic is important?**（领域宏观 / 社会现实意义）
2. **What is currently known?**（已有共识 + 已有方法）
3. **What is critical gap?**（卡住领域前进的 specific barriers）
4. **How does this project address the gap?**（具体到本项目的 contribution）
5. **What's the impact if successful?**（学术 / 应用 / 政策 / 临床）

写作时按目标体例**重新分配**这 5 个问题的篇幅。

## 体例特化提示

### 国家社科 / 教育部人文社科

```
[第 1 段] 选题的理论价值
- 学术史脉络（中外对话）
- 本研究在学科理论上的推进点

[第 2 段] 选题的应用价值
- 服务国家战略 / 政策需求 / 社会发展
- 转化路径（学术 → 政策 → 实践）

[第 3 段] 国内外研究现状述评
- 国外动态（≥ 60% 国际文献）
- 国内进展
- 研究空缺（critical gap）
```

### NIH Significance

```
[结构化 subsection headers]
1. Magnitude of [疾病 / 现象]（流行病学数据）
2. Current understanding（已知机制）
3. Critical Gap（粗体 + 列表）
4. How this project addresses the gap
5. Significance of expected outcomes
```

### NSF Intellectual Merit

```
- 用 Project Description 的 Background / Motivation 段
- 与 Significance 类似但要明确链接到 "advance knowledge"
- 不要混入 broader impacts 的内容
```

### ERC Extended Synopsis

```
- 高度凝练：1-2 段说清"state of the art + critical question + ambition"
- 强调 ground-breaking 不是 incremental
- 引用 ≤ 15 篇关键文献
```

## 反例（每种体例都常见的低分写法）

- **空泛宏大**："本研究对推动 XX 学科发展具有重要意义"（没具体到推动什么、与谁对话）
- **罗列文献**：连续 10 个 "[Smith 2020] 发现 ... [Lee 2021] 发现 ..."，没有评述
- **悲剧叙事**："X 病每年死 X 人 → 所以我做这个"，缺乏机制层面的 gap
- **自我抬高**："本研究是首次 / 国际领先" — 必须有 comparator 才能说"首次"
- **跨学科借词**：把数学 / 物理 / 计算机的术语生硬塞入社科段落

## 工作流

1. 询问目标项目 + 5 个输入信息
2. 检查文献数量 / 质量；如不足主动建议调用 `research-deep` Skill 先补
3. 按目标体例产出**结构化骨架**（带 subsection header）+ **每段第 1 句**
4. 用户填充后帮助 polish（保留原意，提升论证密度）
5. 最后做 **"so what" 自检**：每段读完能否用 1 句话答出"为什么这一段必须写"

## 与其他 Skill 的衔接

- 文献深度调研 → `research-deep`
- 学术英文 polishing → `nature-polishing` / `econ-write`
- 社科基金选题禁区检查 → `nssf-guide.md`
