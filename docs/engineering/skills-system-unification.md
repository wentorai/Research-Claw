# Skills 系统统一化实施与验收 SOP

> 分支：`codex/skills-system-unification`
>
> 基线：Research-Claw Core 0.8.1、OpenClaw 2026.6.1、research-plugins 1.4.8。
>
> 产品边界：Skills 是本地化科研操作系统的可执行能力，不是一个只负责展示数量的插件目录。所有改动必须保证人在回路、来源可溯、过程可审计，并且不能把路线规划表述成已经交付。

## 1. 已确认的问题与证据

本轮不从假设出发。以下问题均已通过源码、真实 Gateway payload、Dashboard 刷新或真实模型调用复现：

1. **检索孤岛**
   - `skill_search` 只索引 research-plugins catalog 的 433 个叶子 Skill。
   - workspace 中新安装的 `style-journal-rewrite` 可被 OpenClaw 原生发现和显式调用，但使用精确名称调用 `skill_search` 返回 0。
2. **执行披露误报与漏报**
   - 中文 STROBE 请求返回 5 个搜索候选，实际只采用其中一个，聊天执行详情却把 5 个都计为已使用。
   - RP Router 下的叶子 Skill 不一定存在于 OpenClaw 当前 `resolvedSkills` snapshot，直接 `read` 叶子文件可能漏记。
3. **渐进式披露失衡**
   - 实际 Skills prompt 为 compact 格式：102 个条目、约 16,842 字符，description 已全部省略。
   - `skill_search` 单次返回 3–5 个完整 SKILL.md；STROBE 实测返回约 35,496 字符。
   - 系统同时常驻披露 151 个工具、约 79,157 个 schema 字符。
4. **Extensions 状态不可信**
   - OpenClaw 返回 `openclaw-workspace`、`openclaw-extra` 等结构化 source，Dashboard 却用路径片段推断来源，导致 workspace 与 RP Skills 被误分组。
   - Dashboard 未展示 `modelVisible`、`userInvocable`、`commandVisible`、`blockedByAgentFilter`。
   - toggle 失败被吞掉，UI 仍可能显示成功。
5. **安装入口不闭环**
   - CLI 和 OpenClaw Gateway 已具备部分安装能力；Research-Claw Extensions 没有统一安装入口。
   - 现有 archive RPC 只接受单 Skill 根目录 ZIP，无法直接处理多 Skill 安装包。
6. **Python 安全扫描缺口**
   - 外部医学包包含 25 个 Python 文件和 7 个 `.pyc`，现有安装扫描路径只检查 JS/TS。
   - 缺失依赖声明的 Skill 可能显示 eligible，但实际执行时才失败。

## 2. 任务状态

| Task | 范围 | 状态 | 完成提交 |
|---|---|---|---|
| T0 | 隔离、证据、SOP、基线 | 已完成 | `docs(skills): define unification delivery SOP` |
| T1 | 统一 Registry 与 provenance 契约 | 已完成 | `8070b14` |
| T2 | 跨来源 search → 单项 load | 已完成 | `8070b14` |
| T3 | candidate/selected/loaded/executed 追踪 | 代码完成；真实 Gateway 门禁待 T8 | `5fc0a7b` |
| T4 | Python、pyc 与依赖安全预检 | 待开始 | — |
| T5 | 安装预检与原子安装 RPC | 待开始 | — |
| T6 | Extensions 安装中心与真实状态 | 待开始 | — |
| T7 | 注入预算与渐进式披露降噪 | 进行中 | `e7b1c0e`（默认值仍待真实 A/B） |
| T8 | 全量、真实 Gateway/模型、文档验收 | 待开始 | — |

## 3. 每个 Task 的问题、改动、收益、风险与验收

### T0：隔离、证据与基线

**目标问题**

主工作区已有聊天输入、样式等未提交改动，另有 observability、supervisor 等 worktree。直接在 main 开发会混入或覆盖并行工作。

**代码与方法**

- 从固定 HEAD 建立独立分支与 worktree。
- 记录本文件中的证据、边界和验收口径。
- 跑 Registry、execution trace、installer、Extensions 的现有基线测试。

**预期收益**

- 每项变更可以独立 review、commit、cherry-pick 和回滚。
- 测试失败可以明确归因于本轮改动。

**风险与应对**

- 风险：依赖目录在 worktree 中重复安装或版本漂移。
- 应对：使用相同 lockfile 与 OpenClaw 6.1 patch；最终在干净安装环境再验证。

**验收**

- worktree 干净且分支正确。
- main 的未提交文件不出现在本分支 diff 中。
- 记录基线测试通过数和既有 warning。

### T1：统一 Skill Registry 与来源契约

**目标问题**

RP catalog 与 OpenClaw 原生 Skills 是两套索引。相同 Skill 在不同界面和工具中可能有不同 ID、source 和可见状态。

**目标代码改动**

- 在 `extensions/research-claw-core/src/skills/` 建立独立 Registry 模块。
- 定义稳定 ID、`sourceKind`、`provenance`、`filePath`、`baseDir`、aliases、requirements 和可见性字段。
- RP catalog、workspace、managed、bundled、plugin/extra router 统一映射为同一条目。

**改动方法**

- 优先消费 OpenClaw 6.1 的真实 `skills.status`/discovery 结果，避免重新实现主机发现算法。
- RP 叶子作为 Registry 的补充 provider，不覆盖原生状态。
- 以规范化绝对路径和 source namespace 构造稳定 ID；同一路径去重，保留多个 provenance 标签。

**预期收益**

- 新装 workspace Skill 能被统一查询。
- Extensions、Agent tool 和执行记录使用同一套身份语义。

**潜在风险与应对**

- 路径泄露：Agent 搜索结果只返回 sourceKind 和 opaque ID，不返回完整用户路径。
- 名称冲突：稳定 ID 包含 source namespace；按优先级选择时显式返回冲突。
- 主机 API 不稳定：所有 OpenClaw payload 通过 adapter 隔离，并用真实 6.1 fixture 固化。

**验收**

- 一个包含 RP、workspace、managed、bundled 的真实 fixture 生成完整且去重的 Registry。
- 同名不同来源不覆盖。
- workspace 精确名称可检索。
- 对 Agent 的返回不泄露 home 绝对路径。

### T2：跨来源轻量搜索与单项加载

**目标问题**

当前 `skill_search` 返回多个完整正文，中文直接查询常为 0，并且无法检索 workspace Skill。

**目标代码改动**

- 将 `skill_search` 限定为 top-k 元数据。
- 新增 `skill_load` 或等价的单项详情工具。
- 增加中英 aliases、规范化分词、确定性打分、结果字符预算和 catalog 分页。

**改动方法**

- 搜索阶段只返回 ID、名称、短描述、来源、匹配理由和 score。
- 加载阶段要求唯一稳定 ID，只允许读取 Registry 已登记且仍在受信根目录下的 SKILL.md。
- 保留旧参数兼容，但不再返回多个正文；在结果中明确迁移提示。

**预期收益**

- 中文科研意图能够确定性召回。
- 单次工具输出从数万字符降到有硬上限的小型候选列表。
- 新装 Skill 无需依赖模型“碰巧知道路径”。

**潜在风险与应对**

- 召回率下降：保留 top-k metadata，增加 aliases，并建立中英文回归集。
- 旧 prompt 期待 `skill_search` 直接给正文：工具描述和 Router 文案同步更新，提供兼容提示。
- 路径穿越：load 前再次做 realpath/根目录 containment 校验。

**验收**

- 中文/英文正例 top-k 命中正确 Skill。
- 精确 workspace 查询命中。
- 负例返回 0。
- 搜索响应硬预算测试通过。
- `skill_load` 一次只能加载一个 Skill；非法 ID、陈旧路径和越界路径均拒绝。

### T3：可信执行生命周期与历史恢复

**目标问题**

搜索候选被计为使用，Router 叶子又可能漏记。用户看到的 Skills 数量不能证明回答真正使用了什么。

**目标代码改动**

- 在执行追踪中区分 `candidate`、`selected`、`loaded`、`executed`。
- 只有 `skill_load` 成功、受信 `skill.used` 或明确 Skill command 才进入聊天角标的“使用”计数。
- detail RPC 返回候选与已使用的独立数组，保持数据库迁移兼容。

**改动方法**

- 搜索工具写 candidate 事件，不写 used。
- load 工具成功后写 loaded/selected，绑定 runId/toolCallId。
- OpenClaw 受信 diagnostic 继续作为原生 Skills 激活的最高优先级证据。
- 对重复事件用 `(run_id, skill_key, lifecycle)` 幂等去重。

**预期收益**

- 刷新前后看到的数字与实际读取一致。
- 执行详情可以解释“搜到了什么”和“真正采用了什么”。

**潜在风险与应对**

- 旧数据库迁移：新增表/列必须可重复运行，不修改旧记录语义。
- built-in 工具缺少 after hook：保留 invoked 状态，不伪造完成。
- 多次读取同一 Skill：使用首次加载时间并保留激活来源。

**验收**

- 搜索 5 个、加载 1 个时：candidate=5、used=1。
- 搜索后不加载：聊天角标 Skill 数量为 0。
- 原生 workspace 显式命令仍计为 1。
- Router → 叶子读取有真实 E2E。
- 刷新和 Gateway 重启后 detail 与 summary 一致。

### T4：Python、pyc 与依赖安全预检

**目标问题**

安装器可能对含 25 个 Python 文件的包报告“扫描 0 文件”；`.pyc` 无法审阅，缺失依赖又会制造假可用。

**目标代码改动**

- 扩展 archive/install 扫描文件类型。
- 增加 Python 危险调用、混淆、网络、子进程规则。
- `.pyc` 和 `__pycache__` 明确阻断。
- 将 `metadata.openclaw.requires/install` 解析到预检结果。

**改动方法**

- 优先通过 Plugin SDK/RC 安装预检层复用；只有所有安装入口无法覆盖时才采用最小 pnpm patch。
- 诊断包含文件、行号、规则、severity 和可恢复建议。
- 安全扫描和依赖满足分开表达，不能用一个 `eligible` 混合。

**预期收益**

- Python Skill 不再成为安全盲区。
- 用户安装前知道“代码是否安全”和“环境是否能运行”是两个问题。

**潜在风险与应对**

- 静态规则误报：阻断仅用于确定性高危模式；其余作为 warning 并要求确认。
- 过度承诺安全：UI 明示“静态预检不是沙箱保证”。
- patch 膨胀：把复杂规则留在 RC 模块，上游 patch 只做最小 hook。

**验收**

- 安全 Python 通过。
- `eval/exec`、shell、危险 subprocess、混淆下载执行被报告。
- `.pyc/__pycache__` 阻断。
- 缺少依赖的 Skill 显示“可安装但当前不可运行”，不能显示成完全可用。

### T5：安装预检、来源适配与原子安装 RPC

**目标问题**

现有入口分散，Gateway ZIP 只支持单 Skill；用户无法安全预览并选择多 Skill 包。

**目标代码改动**

- 提供统一 preview/commit 协议。
- 支持现有 ClawHub catalog、Git/本地导入能力及多 Skill ZIP。
- 预检返回候选 Skill、冲突、hash、扫描、依赖、安装目标和是否需要覆盖确认。
- commit 使用 stage → validate → atomic rename → rollback。

**改动方法**

- 复用 OpenClaw 已有 installer 和 RC 已验证的原子安装模式。
- ZIP 仅解压到随机临时目录，限制条目数、展开大小、单文件大小和目录深度。
- 自动发现多个 SKILL.md 根，但不跨根共享不明确的可执行文件。
- preview 生成短期 token；commit 必须携带 token、选中项和每项冲突决策。

**预期收益**

- 外部包在进入 workspace 前即可审查。
- 部分失败不会留下半安装状态。

**潜在风险与应对**

- ZIP bomb/Zip Slip：路径规范化、大小预算、entry 数上限和 symlink 拒绝。
- TOCTOU：preview 保存 hash；commit 重新校验。
- Git/远端供应链变化：固定 resolved commit/hash，展示来源。
- 覆盖用户 Skill：默认 keep-both，覆盖需要逐项确认并备份。

**验收**

- 用户提供的 10 Skill ZIP 能预览为 10 项，而不是直接安装。
- 默认阻断含 `.pyc` 项；修复后可选择单项安装。
- 冲突默认 keep-both。
- 人为制造中途失败后，旧版本仍完整且无 staging 残留。

### T6：Extensions 安装中心与运行态状态

**目标问题**

Extensions 不能正确解释来源和真实可用性，也没有统一安装流程。

**目标代码改动**

- 用真实 6.1 payload 补全类型和 fixture。
- 修复 provenance 分组、toggle 假成功、重连陈旧状态。
- 增加安装中心：来源选择、预检、逐项选择、冲突与安全确认、结果。
- 展示安装、发现、允许、模型可见、命令可用、运行依赖等独立状态。

**改动方法**

- Store 只做规范化和状态管理；复杂 UI 拆成独立组件。
- 不把 config enabled 等同于 runtime loaded。
- 后端不支持的来源明确禁用并解释，不提供伪成功按钮。

**预期收益**

- 用户能回答“装在哪里、为什么不可用、模型能否看到、是否能作为命令调用”。
- 安装流程与 Workshop、RP、OpenClaw 原生 Skills 使用同一来源语义。

**潜在风险与应对**

- 500+ 条目渲染：保留虚拟列表，安装面板按需挂载。
- 状态过多造成认知负担：列表展示一个综合状态，详情展示状态链。
- Gateway 重启：connection generation 变化时失效并重拉。

**验收**

- RP、workspace、managed、bundled 分组正确。
- toggle RPC 失败显示错误且状态回滚。
- 断线重连后自动刷新。
- 安装成功后无需页面刷新即可显示；页面刷新和 Gateway 重启后仍存在。
- 缺依赖、被 agent filter 阻断、不可命令调用等状态文案准确。

### T7：注入预算与渐进式披露降噪

**目标问题**

当前初始目录已经 compact 丢描述，而召回后又注入多个全文；工具 schema 常驻成本更大。

**目标代码改动**

- 为候选列表、单 Skill 正文、catalog 分页设置独立硬预算。
- 更新 Router/系统提示，使模型遵循 `search → load one`。
- 提供上下文预算 telemetry 与回归脚本。
- 对 40 Router → 6 Router、工具按需披露做可逆配置和 A/B，而不是直接默认切换实验能力。

**改动方法**

- 先完成两阶段 Skill 工具，再减少 Router；避免同时改变召回入口和衡量口径。
- 默认不启用未经验证的 structured Tool Search；提供实验开关和基线报告。
- 所有计数从实际 manifest/status 生成，不使用 431/438/30K 等硬编码。

**预期收益**

- 初始 prompt 保留有意义的短描述。
- 单次 Skill 召回输出可预测。
- 有数据地判断 Router 和工具披露策略，而不是凭感觉削减能力。

**潜在风险与应对**

- 降噪导致漏召回：中英文正例/模糊/负例每条至少 3 次真实会话。
- 实验开关改变生产行为：默认保持保守模式，只有达标后才切换。
- Provider 差异：至少在当前默认模型和一个备用模型上对比。

**验收**

- `skill_search` 不返回 SKILL.md 正文。
- `skill_load` 只返回一个正文且受预算保护。
- prompt 报告不进入未声明的 truncation；compact 状态必须成为显式指标。
- 记录召回率、误触发率、首 token 延迟和上下文字节差异。

### T8：整合、真实运行与文档

**目标问题**

单元测试通过不能证明安装、刷新、模型调用和历史恢复真实闭环；旧文档还存在 one-level/431/30K 等漂移。

**目标代码改动**

- 更新架构、Workshop、用户安装和 troubleshooting 文档。
- 用真实 Gateway payload fixture 替换伪造 source。
- 新增可重复的召回/注入预算验收脚本。

**改动方法**

- 逐个 cherry-pick 已通过的 Task commit。
- 每次 cherry-pick 后跑对应测试，最后跑 root、Dashboard 全量 build/test。
- 使用隔离配置、端口、数据库和 workspace 启动 Gateway，禁止污染当前 28789 实例。
- 最后才执行真实模型正例、模糊例、负例。

**预期收益**

- 交付结果可由维护者复现。
- 文档、测试和运行态数字来自同一事实源。

**潜在风险与应对**

- 真实模型非确定性：每条至少 3 次，记录 runId 和工具/Skill 生命周期，不只判断答案文本。
- 外部服务不稳定：区分“召回失败”和“下游 API 失败”。
- 与并行 RC 工作冲突：最终只在独立分支交付，不主动合入 main 或 push。

**验收**

- 三个 Epic 的专项测试、全量测试和 build 通过。
- 新 Skill：预检 → 安装 → Extensions 显示 → 自然/显式调用 → 执行披露 → 刷新/重启恢复闭环。
- RP：中文召回只加载一个叶子；真实科研工具 smoke 通过。
- 负例不误触发。
- 最终 diff 不包含 main 原有未提交修改。

## 4. 所有 Task 的强制执行 SOP

每个 Task 必须按以下顺序执行，不能把“代码写完”当成完成：

1. **复习 TODO 和细节**
   - 阅读本 Task 目标、非目标、依赖和前一 Task 的验收记录。
   - 检查 worktree、分支和 git status。
2. **观察**
   - 阅读 OpenClaw 6.1 实现。
   - 捕获或复用真实 Gateway payload。
   - 复现目标问题，并记录失败断言。
3. **应用修改**
   - 优先级：配置/Skill 覆盖 → Plugin SDK → 最小 pnpm patch。
   - 保持兼容边界、错误分类和幂等性。
4. **测试与验收**
   - 先跑精确单元/契约测试。
   - 再跑跨层 parity/integration。
   - 涉及运行态时必须跑隔离 Gateway；涉及召回时必须跑真实模型。
5. **提交**
   - 只暂存本 Task 文件。
   - 提交信息说明行为结果，不用模糊的 “update/fix stuff”。
   - 禁止 push。
6. **更新 Task 状态**
   - 在本文件记录 commit、测试和残余风险。
   - 在 Codex plan 中同步状态。
   - 若验收不通过，保持进行中，不得以“已有代码”标记完成。

## 5. 执行记录

### T0 执行记录

- 隔离 worktree：`research-claw-worktrees/skills-system-unification`
- 固定起点：`602db577e6b7d4d36e9131ee4d8363b619c3ff8c`
- 主工作区未提交的 `MessageInput`、`ReferenceMenu`、`SlashCommandMenu` 和样式修改未进入本分支。
- Dashboard 全量基线：152 个 test files、2263 tests passed、1 skipped。
- execution trace/skill usage 基线：2 个 test files、7 tests passed。
- RP installer 基线：
  - 首次在未构建的 clean worktree 中，有 4 项因 `openclaw-weixin/dist/index.js` 不存在而失败。
  - 完成 `pnpm install --offline --frozen-lockfile` 与 `pnpm build:extensions` 后重跑，12/12 通过。
  - 该失败已归类为干净 worktree 的构建前置条件，不是产品代码回归。

### T1/T2 执行记录

- 先复现两套发现孤岛和旧 `skill_search` 多正文注入，再基于 OpenClaw 2026.6.1 的公开 `skills list/info --json` 状态合同实现 adapter。
- Registry 统一发现 RP leaves/routers 与 OpenClaw workspace、managed、bundled、extra；稳定 ID 带来源 namespace，Agent 结果不返回本地路径。
- `skill_search` v2 只返回候选元数据，默认 4,000、最高 8,000 字符，最多 8 项；`skill_load` 只接受稳定 ID 或唯一精确名称，单正文上限 40,000 UTF-8 bytes，超限拒绝而不截断。
- 路径同时做 lexical 与 realpath containment；symlink 逃逸测试通过。
- 真实 RP smoke：577 个统一条目，其中 RP 433 leaves、40 routers；中文“系统综述”和 STROBE 召回命中。
- 集成验收：Registry、OpenClaw status、skill usage、execution trace 共 22/22 通过；Core build、typecheck 通过。
- 残余风险：OpenClaw CLI adapter 首次冷调用有数秒开销，由 snapshot cache 吸收；中文 aliases 仍需从真实召回日志持续扩展。

### T3 执行记录

- 先写红灯合同：`search 5 → load 1`、search-only、受信 native diagnostic、v21→v22 migration、服务重建、detail RPC 与 Dashboard 恢复。
- 新增 `rc_execution_skill_events`，用 `(run_id, skill_key, lifecycle)` 幂等保存 candidate/selected/loaded/executed；旧 `rc_execution_skills` 继续只承担角标真实使用计数，保持兼容。
- `skill_search` 只写 candidate；成功 `skill_load` 以事务写 selected/loaded 和 used；OpenClaw 受信 `skill.used` 以事务写 executed 和 used。
- Dashboard 将“实际加载/执行”与“检索候选”分区展示，旧 Gateway 不返回 `skillEvents` 时保持兼容。
- OpenClaw 6.1 源码核对：`after_tool_call` 的真实 event 含 `result?: unknown`，传入的是保留结构化 `details` 的 `sanitizedResult`。
- 验收：Core 全量 47 files passed、1 skipped，1,143 tests passed、10 skipped；Dashboard execution/chat 相关 63/63；Core build、Core/Dashboard typecheck；secret scan 均通过。
- 未关闭门禁：隔离 Gateway 中完成真实 `skill_search → skill_load → reply → refresh/restart` 后，T3 才从“代码完成”变为“验收完成”；该步骤并入 T8。

## 6. 总体验收门槛

以下任一条件不满足，三个 Epic 均不得宣称“完美”或“完整闭环”：

- 搜索候选和实际使用仍混为一个数字。
- workspace 新 Skill 仍无法被统一搜索。
- 安装含 Python 的 Skill 仍显示“扫描 0 文件”。
- 多 Skill ZIP 可绕过预检直接写入 workspace。
- Extensions 仍以路径猜测真实来源，或把 enabled 当作 model-visible。
- 搜索仍一次返回多个完整 SKILL.md。
- 刷新或 Gateway 重启后执行详情消失。
- 仅凭答案文本判断 Skill 已使用，而没有真实加载/激活证据。
