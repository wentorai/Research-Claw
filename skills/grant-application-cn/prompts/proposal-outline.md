# Prompt: 通用资助申请书提纲生成

## 用途
根据用户提供的研究问题与目标资助项目，**自动识别项目类型**并产出**符合该项目体例**的提纲（含每节字数 / 页数指引）。

## 输入要求

请用户提供以下信息（如缺失主动提问）：

1. **目标资助项目**（如"国家社科基金一般项目"、"NIH R01"、"ERC Starting"、"NSF CAREER"等）
2. **PI 资历摘要**（学位 / 职称 / 主要代表作 / 主持过的项目）
3. **研究问题 / 假设**（1-3 句）
4. **拟用研究方法**（理论 / 实证 / 调研 / 历史 / 实验等）
5. **是否已有 preliminary data / 文献 / 团队**

## 工作流程

### Step 1: 项目类型识别 + 体例匹配

根据用户输入，匹配以下知识源：
- 国家社科 / 教育部人文社科 → `references/nssf-guide.md` + `references/moe-humanities.md`
- NSFC / 各类自然科学基金 → 调用 `nsfc-application-skill`（互补 Skill）
- 省部级 / 博士后 → `references/grant-types-china.md`
- NIH R01 → `references/nih-r01.md`
- NSF Standard / CAREER → `references/nsf-broader-impacts.md`
- ERC StG / CoG / AdG → `references/erc-cv-and-track-record.md`
- MSCA PF → `references/grant-types-international.md`

### Step 2: 产出提纲

按目标项目体例输出，格式示例：

```
# [项目名称] 申请书提纲（v0.1 草稿）

## 资料卡
- 项目类型：______
- 资助强度：______
- 周期：______
- 关键截止日期：______

## 论证主体（按体例）

### Section 1: [Specific Aims / 立项依据 / Excellence Synopsis]
- 字数 / 页数指引：______
- 必含要素：
  □ [要素 1]
  □ [要素 2]
- 第一稿 placeholder（≤ 200 字）

### Section 2: ...（按项目体例继续）

## CV / Track Record（如适用）
- 篇幅指引：______
- 推荐结构（按 references/erc-cv-and-track-record.md 模板）

## 预算（如适用）
- 总额上限：______
- 主要科目 + 比例规划：______

## 评审视角自检 checklist（按 references 文件抽取）
□ [项目特定的自检项目]
```

### Step 3: 主动询问

提纲产出后主动问用户：

- "需要我先深入展开 [Section X] 吗？"
- "PI biosketch / track record 这块是否需要按 NIH 5-page 体例 / ERC 2+2 page 体例改写？"
- "预算我可以按 [资助方] 体例先列科目骨架吗？"

## 注意事项

- **不要把国家社科的"立项依据"模板套到 NSF**：体例完全不同
- **prompt 输出禁止虚构数据**：若用户尚无 preliminary data，标注"需补充"而不是编造
- **多目标项目兼容**：如用户同时考虑 NIH R01 + NSFC，先按一个体例出，再做"映射表"提示哪些段落可复用
- 提醒用户最终以**当年指南 / RFA** 为准
