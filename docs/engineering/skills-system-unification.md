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
| T3 | candidate/selected/loaded/executed 追踪 | 已完成；真实进程重启恢复通过 | `5fc0a7b`、`960bcbd` |
| T4 | Python、pyc 与依赖安全预检 | 已完成；独立安全复核 PASS | `8c877dd`、`6fab94d` |
| T5 | 安装预检与原子安装 RPC | 已完成；外部 10-Skill ZIP 真实安装/阻断闭环通过 | `8c877dd`、`49d6ec1`、`6fab94d` |
| T6 | Extensions 安装中心与真实状态 | 已完成；专项、全量与浏览器验收通过 | `b6c8932`、`e194b61` |
| T7 | 注入预算与渐进式披露降噪 | 已完成；DeepSeek OFF/ON 与 Kimi 保守配置重复采样通过 | `e7b1c0e`、`960bcbd` |
| T8 | 全量、真实 Gateway/模型、文档验收 | 已完成；真实安装、调用、科研工具与历史恢复闭环通过 | 本提交：`docs(skills): close unification acceptance` |

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

- 统一 ClawHub 与本地多 Skill ZIP 的发现、预检和安装交互。
- ClawHub 复用 OpenClaw 原生 search/detail/install RPC；本地 ZIP 在浏览器内拆成逐 Skill 的原生 archive upload。
- 预检返回候选 Skill、冲突、hash、客户端静态扫描、依赖提示、安装目标和是否需要覆盖确认。
- 服务端安装继续使用 stage → validate → atomic rename → rollback，并在写目标前执行 `before_install` 安全钩子。

**改动方法**

- 复用 OpenClaw 已有 installer 和 RC 已验证的原子安装模式，不伪造 Gateway 6.1 不存在的 scan-only/preview-token RPC。
- ZIP 只在受限内存中解析，限制 archive 大小、条目数、展开大小、单文件大小、压缩比和目录深度。
- 自动发现多个 SKILL.md 根，但不跨根共享不明确的可执行文件；每个候选独立上传、独立提交。
- 浏览器预检负责早期反馈，服务端 `before_install` 才是写入前的权威阻断点；两层都重新计算内容摘要。

**预期收益**

- 外部包在进入 workspace 前即可审查。
- 部分失败不会留下半安装状态。

**潜在风险与应对**

- ZIP bomb/Zip Slip：路径规范化、大小预算、entry 数上限、压缩比上限和 symlink 拒绝。
- TOCTOU：客户端摘要仅用于展示与幂等；服务端基于实际上传内容重新扫描，不信任客户端结论。
- Git/远端供应链变化：固定 resolved commit/hash，展示来源。
- 覆盖用户 Skill：默认 keep-both，覆盖需要逐项确认并备份。
- 多 Skill 包不是整包事务：UI 必须逐项报告成功/失败，不能把“部分成功”显示成整包成功。

**验收**

- 用户提供的 10 Skill ZIP 能预览为 10 项，而不是直接安装。
- 默认阻断含 `.pyc` 项；修复后可选择单项安装。
- 冲突默认 keep-both。
- 人为制造中途失败后，旧版本仍完整、失败项目标不存在且无 staging 残留。

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
- 真实进程重启门禁已关闭：进程 A 完成 `skill_search → skill_load → reply` 并写入 SQLite，退出后由进程 B 打开同一数据库；回复与 run 的映射、candidate/selected/loaded 生命周期、summary 和 detail 均恢复，刷新后没有把 candidate 误计为 used。
- 提交与状态：实现提交为 `5fc0a7b`，`960bcbd` 补齐确定性顺序和渐进式默认值；T3 已完成，其全量回归仍统一纳入 T8。

### T4 执行记录

**复习 TODO、目标问题与证据链**

- 目标不是“多扫几个扩展名”，而是消除安装前的可执行代码盲区，并保证安全组件缺席、异常或资源耗尽时不会静默放行。
- 用户提供的医学包含 Python 源码、`.pyc` 和 `__pycache__`；旧扫描器只看 JS/TS，能够出现“扫描 0 个文件”但随后把不可审阅字节码写入 workspace 的真实缺口。
- 源码复核还确认了四类绕过面：中文/英文 prompt injection 可藏在 `SKILL.md` 或支持文档；可执行内容可藏在 shebang、native binary 或不受支持的脚本格式；symlink/嵌套归档可越过目录边界；超大文件、超深目录和超多条目可消耗扫描资源。
- 依赖可满足性与安全性是不同维度。RC 预检里的 `runtimeReady` 只是当前静态依赖快照，**不是 OpenClaw 的 canonical eligibility**；安装/重载后的真实状态仍以 OpenClaw `skills.status.eligible` 及其诊断为准。

**观察与失败断言**

- 建立了安全 Python、危险 `eval/exec/compile/import`、反序列化、动态属性/Unicode alias、native library、shell/subprocess、下载执行链的成对正负样本。
- 对 `.py`、`.pyw`、extensionless Python shebang、`.pyc/.pyo`、`__pycache__`、ELF/Mach-O/PE/native 扩展、symlink/特殊条目、opaque nested archive、vendored `.git/node_modules` 建立阻断合同。
- 对 VBS、R、notebook、Makefile、带 scripts 的 `package.json` 等当前无法可靠审查的可执行格式建立 fail-closed 合同，而不是以“没有命中规则”代表安全。
- 对中文/英文越权、忽略系统指令、窃取秘密等 prompt injection 建立阻断样本，同时保留“讨论 system prompt 安全”一类良性文本，验证不是关键词即阻断。

**应用修改与代码方法**

- RC Core `before_install` 统一扫描 Skill 根和支持文件，检测 Python/shell/PowerShell/CMD、prompt injection、compiled/native payload、symlink、嵌套归档和不支持的可执行格式；诊断携带规则、文件和可行动原因。
- 扫描设置总字节、文件/目录数量、目录深度、单文件大小等资源预算；读取失败、配置访问异常、内容截断或预算溢出均 fail closed。
- OpenClaw 2026.6.1 patch 将 CLI install/update、ClawHub、archive/local/Git、依赖安装、Workshop 和 migration 的最终写入都置于 staging scan 之后，并保证阻断时不覆盖既有目标、不留下 staging。
- 无 RC Core 的边界经过单独测试：文档型安全 Skill 可以继续安装；Python 等需要 RC 深度扫描的源代码会因缺少扫描器而拒绝；native、不支持格式和中英文 prompt injection 仍由 OpenClaw 最小防线阻断。插件 target 仍交给 OpenClaw 自己处理，RC Skill scanner 不越权接管 plugin 安装。

**预期收益**

- 本轮覆盖的受管安装入口在写入前共享同一 fail-closed 边界，Python、字节码、native 和隐藏脚本不再是“未扫描即通过”。
- 安全结论、依赖声明和运行态资格分开展示，避免把“可安装”“当前可运行”“OpenClaw 已加载”混成一个绿色状态。

**风险与应对**

- 静态规则存在误报和未知绕过；通过良性对照、具体 ruleId/文件诊断和受控例外迭代降低误伤，但不把命中不全包装成执行安全。
- **静态预检不是沙箱**：它不能证明 Skill 运行时无害，也不能替代最小权限、人工审查、依赖供应链控制和运行态隔离。
- patch 触及多个 OpenClaw 安装面；复杂扫描留在 RC Core，patch 只保留 staging/调用/无 Core 最小防线，并用 frozen-lockfile 安装验证防止补丁漂移。

**测试、验收、提交与状态**

- 最新专项结果：RC Core 安全合同 31/31；真实 OpenClaw 安装安全合同 7/7；版本锁与安装安全联合合同 10/10。
- OpenClaw 6.1 patch 已通过 frozen-lockfile 安装，并在官方 `openclaw@2026.6.1` tarball 上完成 apply check、实际 apply 和 reverse check；25 个 patched 文件与当前 runtime 逐文件一致，既有 `camera=(self)` 权限 hunk 由版本合同保护。
- 官方 bundled 依赖安装采用窄例外：仅 `origin=openclaw-bundled` 且存在 OpenClaw `installSpec` 时允许脚本进入官方依赖配方；同一目录改为 managed 来源仍 fail closed，native、opaque archive、不支持格式、资源超限和 prompt injection 不受例外影响。42 个带安装配方的 bundled Skills 全部通过回归。
- RP 433 个叶子 Skill 安全矩阵为 0 blocked、0 critical；只有两个用于安全/沙箱说明的预期 warning。外部医学 ZIP 的 3 个阻断项仍被准确阻断。
- 独立安全复核结论为 PASS，无 P0/P1 阻断项。实现提交为 `8c877dd` 和 `6fab94d`；T4 已完成。
- 残余边界：静态扫描不是 AST 数据流分析或沙箱。多跳 callable alias、变量化 `getattr`、无扩展名且由指令交给解释器的载荷仍可能逃逸启发式规则；手工复制、`npx-skills`、plugin bundle 内 Skills 等绕开受管安装器的路径属于另一信任边界。它们必须通过最小权限、来源审查和运行时隔离治理，不能被本预检结论覆盖。

### T5 执行记录

**复习 TODO、目标问题与证据链**

- 真实问题是“用户能否在写入 workspace 前理解一个外部包里有什么，并让服务端独立阻断危险项”，而不是只增加一个上传按钮。
- OpenClaw 6.1 的原生 archive install 没有 scan-only preview RPC；如果前端伪造一个“服务端已验证”预览，会造成错误信任。
- 多 Skill ZIP 不能作为一个单 Skill archive 直接提交；若缺少拆包、预算和逐项结果，既会绕过用户选择，也无法表达部分成功。

**观察**

- 外部文件 `10个医学科研skills安装包.zip` 的 SHA-256 为 `e072d301e4dff5e46a4559f9bb83fd6ee5037b1ed1ed66e2cd96ca62186836a1`，可稳定发现 10 个 Skill。
- 浏览器结构预检得到 7 项可进入后续安装、3 项因 compiled artifacts 阻断；三项分别为 `format-references-endnote`、`format-references-zotero` 和 `Medical Review Writer`。
- 服务端语义进一步区分为：3 项安全阻断、6 项允许安装但 `runtimeReady=false`、1 项允许安装且 `runtimeReady=true`。这里的 `runtimeReady` 仅是 RC 当前依赖预检提示，不能替代 OpenClaw 安装后 canonical eligibility。

**应用修改与代码方法**

- 浏览器端在受限内存中解析 ZIP，执行路径规范化、entry/展开大小/单文件/目录深度/压缩比预算和 symlink/compiled-artifact 预检，并对每个候选计算内容摘要。
- 每个选中 Skill 被重新打包为独立 archive，调用 OpenClaw 原生上传；客户端结论不被服务端信任，RC Core `before_install` 在实际写入前重新扫描上传内容。
- ClawHub 使用原生 search/detail/install；未实现 scan-only 的来源不展示伪成功。当前 UI 没有伪造 Git 安装能力，后续若开放必须复用同一服务端门禁。
- 原子性定义为“每个 Skill 独立 stage/validate/rename/rollback”，不是“整个 10 项安装包全有或全无”；UI 保存每项结果并明确部分成功。

**预期收益**

- 用户可以先看到 10 项候选、每项风险和依赖提示，只提交明确选择的项目；危险项目即使绕过浏览器也会被服务端拒绝。
- 单项失败不会污染其他项目或覆盖已有目标，重试可依据 digest 保持幂等。

**风险与应对**

- ZIP bomb、Zip Slip、压缩比和内存耗尽：两层路径校验与硬资源预算，超限 fail closed。
- TOCTOU/客户端篡改：摘要用于展示和幂等，服务端总是扫描实际 upload，不接受客户端“clean”作为授权。
- 整包部分成功被误解：结果页逐项展示，失败项允许修复后单独重试。
- **预检仍是静态检查，不是沙箱或运行时行为证明**；安装后还必须等待 OpenClaw 重新发现并检查真实资格。

**测试、验收、提交与状态**

- 最新真实 native upload：clean Skill 上传并安装成功；EndNote 项在服务端因 compiled artifact 被阻断，失败后目标目录不存在，未留下半安装目标。
- 外部 ZIP 的 10 项发现、3 项阻断/6 项未就绪/1 项就绪、逐项选择和摘要合同均已验证；危险项不能借由前端判断差异直接写入。
- 实现提交为 `8c877dd`、`49d6ec1` 和安装边界补强 `6fab94d`。真实上传、服务端阻断、原子回滚、最终全量回归均通过，T5 已完成。

### T6 执行记录

**复习 TODO、目标问题与证据链**

- 目标问题是真实状态不可解释：旧 UI 用路径片段猜 provenance，把 config enabled 当成 runtime loaded，并可能在 toggle RPC 失败后保留乐观成功状态。
- 安装入口若与状态链使用不同身份/来源语义，会出现“刚安装但找不到”“列表显示可用但模型看不到”等假闭环。

**观察**

- 真实 OpenClaw 6.1 payload 提供结构化 source、`modelVisible`、`userInvocable`、`commandVisible`、`blockedByAgentFilter` 和资格诊断；旧 adapter 丢弃或重新猜测了其中部分字段。
- 重连后沿用旧 snapshot、toggle 错误被吞和本地 ZIP 只能单根处理均有对应失败合同。

**应用修改与代码方法**

- Extensions adapter 以 Gateway 的结构化 source/provenance 为事实源，分别呈现“已安装/已发现/允许/模型可见/命令可用/依赖与资格”，不再从路径推断。
- toggle 使用 RPC 结果更新；失败回滚并显示错误。connection generation 变化后使旧数据失效并重拉。
- 安装中心复用 T5 的 ClawHub 与本地 ZIP adapters，按候选项展示风险、依赖、冲突、选择和结果；安装结束后刷新原生 status。
- 列表保留轻量综合状态，详细状态链与安装 UI 按需展开，控制 500+ 条目下的认知和渲染成本。

**预期收益**

- 用户能够追溯“来自哪里、装在哪里、为什么不可用、模型/命令能否看见”，安装结果与运行态不再是两套说法。
- RPC 失败、重连和依赖缺失均表现为可恢复的真实状态，而不是 UI 假成功。

**风险与应对**

- OpenClaw payload 漂移：通过真实 6.1 fixture 和 adapter 边界固化，不在组件内散落兼容逻辑。
- 状态字段过多：列表只显示综合结论，详情保留证据链；`runtimeReady` 明示为 RC 预检提示，不冒充 OpenClaw canonical eligibility。
- 大列表和上传对主界面造成回归：安装中心按需挂载，并保留虚拟列表/现有筛选路径。

**测试、验收、提交与状态**

- Extensions/安装中心专项集成测试 54/54，通过 Dashboard typecheck；中英文资源各 1,481 个 key，键集合一致。
- 提交为 `b6c8932`（Gateway truth/status）和 `e194b61`（native install center）。
- Dashboard 全量为 154 个 test files、2,293 tests passed、1 skipped；生产 build 通过。隔离浏览器先连接 `5176 → 28833` 验证 ClawHub、本地 ZIP 与 native-upload 安装结果，再连接 `5176 → 28831` 验证模型调用同实例；工作区、托管个人和 OpenClaw 内置分组、模型/命令状态及安全边界文案均符合真实 Gateway 状态。
- T6 已完成。

### T7 执行记录

**复习 TODO、目标问题与证据链**

- 目标不是单纯减少 token，而是在保持真实召回率的前提下，把常驻目录、工具 schema、候选元数据和单项正文分层披露。
- 基线同时常驻 123 个工具、约 71,099 个 schema 字符；structured ToolSearch 打开后可降到 3 个工具、约 513 个 schema 字符，但节省上下文不等于召回可靠。

**观察与真实 A/B**

- DeepSeek 严格正例在 ToolSearch OFF 时正确选择 `clinical-research-guide`，约 19.2 秒、2 次工具调用。
- ToolSearch ON 的初始 scorer 误选 `scientific-writing-guide`，约 50.7 秒、10 次调用；加入中英文 alias 和加权 scorer 后，严格正例恢复为 `rp:clinical-research-guide`，约 13.0 秒、5 次调用。
- 自然模糊 STROBE 请求先暴露稳定性问题；调整 aliases/weighted scorer 后，DeepSeek OFF/ON 的严格正例、自然模糊例各重复 3 次，12/12 都真实 selected/loaded `rp:clinical-research-guide`。
- DeepSeek OFF/ON 负例各重复 3 次，6/6 均为 0 candidate、0 selected、0 loaded，没有为降噪制造新误触发。
- Kimi 先前的 provider 429 已恢复；在生产保守配置 ToolSearch OFF 下重跑严格正例、自然模糊例和负例各 3 次：6/6 正例真实加载同一 Skill，3/3 负例为 0 lifecycle。

| 模型/模式 | 样本 | 成功 | 首个模型输出均值 | 总耗时均值 | Prompt tokens 均值 | Tool schema chars | 工具调用均值 |
|---|---|---:|---:|---:|---:|---:|---:|
| DeepSeek / OFF | 严格正例 ×3 | 3/3 | 4,855 ms | 12,621 ms | 42,792 | 71,099 | 2 |
| DeepSeek / ON | 严格正例 ×3 | 3/3 | 3,540 ms | 13,226 ms | 14,160 | 513 | 6 |
| DeepSeek / OFF | 自然模糊 ×3 | 3/3 | 2,612 ms | 25,330 ms | 43,633 | 71,099 | 3 |
| DeepSeek / ON | 自然模糊 ×3 | 3/3 | 2,646 ms | 21,072 ms | 14,071 | 513 | 6 |
| Kimi / OFF | 严格正例 ×3 | 3/3 | 8,003 ms | 17,987 ms | 36,686 | 71,377 | 2 |
| Kimi / OFF | 自然模糊 ×3 | 3/3 | 11,239 ms | 55,413 ms | 37,174 | 71,377 | 4 |

> “首个模型输出”取真实 session JSONL 中 user message 到首条 assistant event 的间隔，可能是 tool call，不冒充供应商网络层的首个可见文本 token。负例 9/9 均无工具/Skill 事件。

**应用修改与代码方法**

- Registry 固定 `search → load one`：搜索只返回 top-k 元数据，单项加载受正文预算、唯一 ID 和受信根校验保护。
- 仅在用户没有显式覆盖时，把 RP Router 收敛为 6 个高层入口并限制 prompt 数量/字符预算；ToolSearch 保留可逆开关。
- 为中英文医学意图补充 alias/weighted scoring，修复严格正例和自然模糊例的错误排序。虽然 ON 将 DeepSeek tool schema 从 71,099 chars 降至 513、prompt tokens 下降约 67%，但每次正例需要 6 次桥接调用，早期 scorer 又真实出现过误选；当前样本只覆盖一个意图族，Kimi 也只验证了保守配置。因此生产默认值继续锁定 `ToolSearch=false`，ON 保留为可逆实验开关。

**预期收益**

- 已实现的两阶段 Registry 消除了“搜索一次注入多个全文”；ToolSearch 在未来达标后还有显著 schema 降噪空间。
- 默认关闭实验开关可避免为了节省 schema 牺牲模糊召回，同时保留继续采样和灰度比较的能力。

**风险与应对**

- scorer 对单一措辞过拟合：严格正例、自然模糊例和负例必须分组重复测试，不能只凭一个成功答案切默认。
- 模型可能绕过 Registry 自行读取泛化 Skill：验收必须看真实 tool/Skill lifecycle，而不只看最终文本。
- Provider 差异和限流：早期 429 与恢复后的重跑结果都保留；备用模型使用同一输入和次数，不用 DeepSeek 结果代替。

**测试、验收、提交与状态**

- DeepSeek OFF/ON 共 18 次最终采样（正例 12、负例 6），Kimi OFF 共 9 次最终采样（正例 6、负例 3）；正例召回/加载 18/18，负例无误触发 9/9。
- 已记录召回率、误触发率、首个模型输出、总耗时、prompt tokens、Skills prompt chars、tool schema chars 和工具次数。数据支持“两阶段 Registry 已默认交付，ToolSearch 保留能力但默认关闭”。
- 提交为 `e7b1c0e` 和 `960bcbd`。T7 的代码、默认值与重复采样门禁均已完成。

### T8 执行记录

**复习 TODO、目标问题与证据链**

- T8 负责证明跨层闭环，不能用单元测试数量替代真实 upload、服务端阻断、OpenClaw 发现、模型召回、执行披露和进程重启恢复。
- 整合阶段曾在多个专项 commit 之后追加安全补强，因此所有早期全量结果均作废，并在最终代码树上重新执行完整门禁。

**观察与已完成门禁**

- 安全：RC Core 31/31、真实 OpenClaw 7/7、版本锁联合合同 10/10；frozen-lockfile 与官方 tarball patch 重放通过，独立安全复核 PASS。
- 外部包：固定 SHA 的 10 Skill ZIP 可发现为 10 项，服务端结论为 3 blocked、6 not-ready、1 ready。
- 安装：clean native upload 成功；EndNote 被服务端阻断，目标不存在且无半安装状态。
- 新装 Skill：`biomedical-sci-manuscript` 的源文件、native upload 目标和模型验收目标的 `SKILL.md` SHA-256 均为 `3934a0d6a1c76a96ad9718a44076ba00bd0d8f48d2de70a14e83938aeb3b478c`。自然意图 run `afb95057…` 经 search 后 selected/loaded `oc:workspace:biomedical-sci-manuscript`；显式 run `e5e78b9f…` 只调用一次 `skill_load` 并加载同一稳定 ID。SQLite 中的 source 为 `workspace`，且同一个 `28831` Gateway 的 Extensions 将其显示为“工作区技能／模型与命令均可用”，不是根据答案文本或另一实例截图推断。
- 真实科研工具：run `921e63d6…` 只调用一次 RP `search_pubmed`；真实 tool result 返回 PMID `40845844`、PubMed 总命中 11,092、source latency 409 ms，最终回答与 tool result 一致。
- 历史：真实 `skill_search → skill_load → reply` 在进程退出并重启后，从同一 SQLite 恢复 reply/run、生命周期、summary/detail。
- 渐进式披露：DeepSeek OFF/ON 18 次与 Kimi OFF 9 次最终采样已完成，支持 ToolSearch 默认关闭。
- UI：Extensions/安装中心专项 54/54、Dashboard 全量 2,293 passed/1 skipped、typecheck/build 和隔离浏览器视觉验收通过。

**应用修改与整合方法**

- 所有行为改动保持在独立分支/worktree；安全补强在完整回归前保持未提交，验收通过后形成独立提交 `6fab94d`，全程不 push。
- 真实 Gateway 验收使用隔离配置、workspace、SQLite 和进程，不复用日常实例；记录的是持久化生命周期和文件系统结果，不以回答文本替代证据。
- 文档必须区分三种事实：静态 `installAllowed`、RC advisory `runtimeReady`、OpenClaw canonical eligibility；同时始终声明静态预检不是沙箱。

**预期收益**

- 维护者可以从固定输入摘要、专项测试、真实安装结果和持久化记录复现关键结论。
- 外部限制和信任边界显式留白，避免“本轮代码闭环”被包装成静态扫描、所有 provider 或所有安装渠道都已经完美。

**风险与应对**

- 最终补强可能破坏非安全路径：在当前树上重新执行 root/Core/Dashboard 全量与 build，而不是沿用旧结果。
- 真实模型非确定性和 provider 限流：以 3 次重复和 run-level lifecycle 判断；保留 Kimi 早期 429 与恢复后 9 次结果，不用单次答案代替。
- 文档与代码分支不同步：最终整合时核对 commit、测试时间点和当前 diff，禁止把计划项写成已交付。

**最终验收、提交与状态**

- Root/Core 全量：113 个 test files passed、4 skipped；1,593 tests passed、12 skipped、22 todo。一次将 Root 与 Dashboard 并行压测时，真实 CLI 用例被资源竞争拉长并触发 Vitest worker 的 `onTaskUpdate` 超时；仓库正式的串行命令重跑全部通过，没有产品断言失败。
- Dashboard 全量：154 个 test files、2,293 tests passed、1 skipped。完整 `pnpm build` 与 `pnpm verify:e2e` 通过；Vite 只报告既有 chunk/dynamic-import 警告。
- `pnpm install --offline --frozen-lockfile`、版本锁/安全合同、真实 upload、迁移、Workshop、无 Core fail-closed 和 bundled dependency recipe 均通过。
- 浏览器视觉/交互验收完成；IME、重连、toggle 回滚、安装后刷新均由专项和全量回归覆盖。相同内容的新装 workspace Skill 已完成自然/显式调用与 lifecycle 落库。
- RP `search_pubmed` 真实公网 smoke 通过；这证明插件工具实际挂载、调用和结果回传，不把 Registry 自身工具冒充 research-plugins 科研工具。
- 当前代码 diff 通过 `git diff --check` 和提交前 secret scan；安全补强提交为 `6fab94d`。根文档同步在独立父仓库分支提交，不与代码 worktree 混合。
- T8 已完成。静态扫描非沙箱、非受管安装入口和同用户进程不构成隔离边界，均不被本轮受管闭环的 PASS 结论覆盖。

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
