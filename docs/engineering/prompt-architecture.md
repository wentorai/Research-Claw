---
doc: engineering/prompt-architecture.md
audience: 开发者 — 渠道 B(仓库按需阅读,不注入运行时)
status: 现行 · 2026-06-09 依代码/提示词重建(对齐 AGENTS.md v4.1)
source-of-truth: 代码优先(workspace/.ResearchClaw/ 八件提示词 + OC 装载器);本文保留设计 why,逐字内容以文件为准
baseline: OpenClaw 2026.6.1 · AGENTS.md v4.1 · DB SCHEMA_VERSION 14
---

# 提示词架构(Bootstrap 文件系统)

> RC 的"行为 DNA"由一组 bootstrap 文件在会话启动时注入 LLM 上下文构成。本文讲这套系统**为什么这样设计**;逐字内容看 `workspace/.ResearchClaw/` 下的真实文件,本文不复制正文。
>
> ⚠️ **术语消歧**:RC 里"L1/L2/L3"出现在三处且含义不同——本文指**提示词文件层**(§3);**耦合层**见 [architecture.md](./architecture.md) §3;**搜索回退层**见 AGENTS.md §3.2。勿混。

## 1. 设计原则

| 原则 | 含义 |
|------|------|
| **精确优于啰嗦** | 每个字符都耗推理 token,只说必要的 |
| **行为优于信息** | bootstrap 定义 agent **怎么做**,不是它**知道什么**;事实知识来自工具与 skills |
| **设计上可被用户编辑** | 全用纯 Markdown,用户可任意增删改 |
| **失效安全默认** | 某文件缺失/为空,agent 仍能运行,只是少了该文件的专门行为 |
| **不留幻觉锚点** | 文件显式告诉 agent **不要做什么**(如编造引用),而非寄望隐性克制 |

## 2. 装载机制

OC 在会话初始化时扫描 workspace,装载八件 bootstrap 文件:`SOUL` `AGENTS` `HEARTBEAT` `BOOTSTRAP` `IDENTITY` `USER` `TOOLS` `MEMORY`(`.md`,大小写敏感)。

1. **路径解析**:workspace 路径来自 config,RC 指向 `workspace/.ResearchClaw/`。
2. **YAML front matter 剥离**:文件开头 `---...---` 在注入前被剥掉,只解析元数据(如 `version`),**不送给 LLM**。
3. **字符上限**:每文件约 **20K 字符**硬上限,全部合计约 **150K**;超出在最近换行处截断。精确预算用 `pnpm health` 的 budget 报告查,本文不写死(会随内容增长漂移)。
4. **拼接顺序**:固定序拼接(SOUL → IDENTITY → USER → AGENTS → TOOLS → MEMORY → HEARTBEAT → BOOTSTRAP),`---` 分隔,注入 system prompt。

### 2.1 Session-aware 过滤(核心 why)

不是每种会话都装全部八件——OC 按会话类型给不同子集:

| 会话类型 | 装载文件 |
|----------|----------|
| **Primary**(主交互) | 全部 8 件 |
| **Subagent**(`agent_delegate` 派生) | SOUL · IDENTITY · USER · AGENTS · TOOLS |
| **Cron**(定时后台) | SOUL · IDENTITY · USER · AGENTS · TOOLS |
| **Heartbeat**(周期健康检查) | 仅 HEARTBEAT(lightweight) |

为什么砍:subagent/cron 是短命、任务专一的会话,装 MEMORY/BOOTSTRAP 是在没用的信息上浪费上下文;BOOTSTRAP 只在主会话跑 onboarding;HEARTBEAT 只对心跳会话有意义。lightweight 模式正是为自动化非交互会话压低 token。

## 3. 文件分层(AGENTS.md §10)

八件文件按"谁拥有、能否被升级覆盖"分三层(权威源 AGENTS.md §10;可由 `.example` 文件是否存在佐证):

| 层 | 文件 | 性质 |
|----|------|------|
| **L1 System** | `AGENTS.md`、`HEARTBEAT.md` | RC 拥有,只读、随升级强制更新;**无 `.example`** |
| **L2 Onboarding** | `BOOTSTRAP.md` → 跑完改名 `.done` | 一次性引导,完成后自禁用 |
| **L3 User** | `SOUL.md`、`IDENTITY.md`、`TOOLS.md`、`USER.md`、`MEMORY.md` | 用户拥有,随 `.example` 模板下发后归用户;**改动不进 git**,靠模板/手动同步 |

> 为什么这样分:L1 是 RC 的行为契约,必须能随版本强推;L3 是用户的个性化,升级绝不能覆盖。所以 L1 不发 `.example`(直接是真身),L3 发 `.example` 模板、真身由用户持有。

## 4. AGENTS.md v4.1 设计决策

AGENTS.md 是行为规格核心(§1–§10)。v4.1(2026-04-05)的关键设计,改这文件时必须遵守:

1. **多层锚定**:关键规则**有意**出现在 2–3 处(如"绝不声称 web_search 不可用"同时在 §3、§3.2、SOUL #6)。这是冗余换可靠,不是重复。
2. **内联关键 schema**:§9 直接写全 6 类卡片的 Required/Optional 字段,而非只给个指向 Output Cards skill 的指针——**skills 退为"增强"而非"必需"**。根因教训:关键规则若只放在 lazy-load 的 skill 里,always-load 的 system prompt 拿不到,卡片就不可靠发出。
3. **工具文本内嵌卡片**:工具在返回文本里带卡片 JSON("Include this card in your response:"),从 `workspace_save` 推广到 `library_add_paper`/`task_create` 等。
4. **卡片分类**:`paper_card`/`task_card`/`file_card` 由**工具发出**;`progress_card`/`monitor_digest` 由**agent 自行组装**(AGENTS §3.1)。
5. **段号神圣**:§1–§10 不可重编号——6 个 skills + SOUL.md 引用了具体 §号;新内容进子节(§3.1/§3.2/…)。

> 完整改版动机与对照(基于 Claude Code system prompt 模式)见 archive 设计稿:`docs/archive/planning/PROMPT-ARCHITECTURE-REDESIGN.md`(历史参考)。

## 5. 与 Skills 的关系

- **bootstrap 文件**定义会话级人格/行为/流程,按会话类型恒定装载,运行时不可关。
- **skills** 定义任务级指令,按激活规则(`always:true`、关键词、显式调用)装载;`always:true` 的 research-sop 是桥梁,保证每会话都有方法论细节补充 AGENTS.md。
- 装载序:bootstrap 先(system prompt)→ skills 后;`always:true` 先于条件激活;单会话最多 150 skills。

## 6. 一致性测试

`bootstrap-consistency.test.ts` 校验结构(章节头、工具数、卡片类型、红线);版本正则接受 `4.[01]`。改提示词后跑它防回归。

---

> 相关:卡片字段细节见 [modules/cards.md](./modules/cards.md);RC 自述 canonical 镜像见 [../self/](../self/);文档体系导航见 [../00-reference-map.md](../00-reference-map.md)。
