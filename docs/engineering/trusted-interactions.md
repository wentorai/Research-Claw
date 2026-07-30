---
doc: engineering/trusted-interactions.md
audience: 开发者 / QA / RC Agent 排障
status: 现行 · 2026-07-30
source-of-truth: dashboard、research-claw-core、dual-model-supervisor 代码与测试
baseline: OpenClaw 2026.6.1 · DB SCHEMA_VERSION 20
---

# 可信交互：可信审查、快捷指令与执行详情

## 1. 产品语义

这三项能力共同回答三个不同问题：

1. **可信审查**：系统是否检查过回复或操作，采取了什么处理。
2. **执行详情**：这条 Agent 回复实际调用了哪些工具、启用了哪些 Skill。
3. **快捷指令**：用户如何复用常用输入，同时保留编辑和发送控制权。

“可信”只表示过程可检查、可追溯，不表示答案必然正确。Reliable Sources 与
claim-evidence 绑定不属于当前实现。

## 2. 可信审查

用户入口统一称“可信审查”，页面称“审查记录”，设置主项称“回复与操作审查”。
Reviewer、模式、模型来源和 session 等实现信息位于“技术详情”折叠区。

- 基础确定性安全检查与深度模型审查是不同状态；深度审查不可用时，不得把基础检查描述为已关闭。
- `rc.supervisor.log` 的 `total` 来自与列表相同筛选条件的独立 count，不是当前页长度。
- 全量清理必须调用 `rc.supervisor.log.clear` 且显式传入 `{ scope: "all" }`。
- Dashboard 必须二次确认；清理只删除审查日志，不关闭审查、不删除聊天。
- 清理后广播 `plugin.supervisor.review.cleared`，其他 Dashboard 实例应重载状态。

## 3. 快捷指令

数据表为 `rc_prompt_presets`。稳定 RPC 为：

- `rc.prompt-presets.list/create/update/delete`
- `rc.prompt-presets.reorder`
- `rc.prompt-presets.mark-used`

交互约束：

- 选择快捷指令只插入输入框，绝不调用 `chat.send`。
- 有选区时替换选区；无选区时在光标处插入；空输入正常插入。
- 首选浏览器原生 `insertText` 编辑事务，回退到 `setRangeText`，保证 React 状态同步。
- composition 期间按钮和选择动作不得介入中文输入。
- 自动检测高频输入与建议创建快捷指令是后续异步能力，当前不实现。

## 4. 回复级执行详情

### 4.1 工具观测

`before_tool_call` 是计数权威，覆盖内建与插件工具。数据以
`(run_id, tool_call_id)` 去重写入 `rc_execution_tools`。
`after_tool_call` 可用时补全 completed/error 和耗时；缺失时保留“已调用”，不得伪造成功。

默认不持久化工具参数和结果正文。错误仅保留截断后的诊断文本。

### 4.2 Skill 识别

Skill 识别不使用聊天关键词或工具名称猜测。只有以下真实证据可记入
`rc_execution_skills`：

- `read` 精确读取权威 research-plugins 索引中已登记 Skill 的 canonical `SKILL.md`；
- `skill_search` 的真实返回值明确包含该 Skill。

任意未登记的 `SKILL.md`、普通 Markdown、同名目录均不得命中。重复读取以
`(run_id, skill_key)` 去重。该策略与 OpenClaw 2026.6.1
`agent-tools.before-tool-call.ts` 的精确读取识别原则对齐。

### 4.3 回复绑定与 UI

- 当前 final assistant event 直接绑定 `executionRunId=event.runId`。
- 服务端轨迹是事实源；Dashboard 通过 `rc.execution.summary/detail` 批量汇总、按需取详情。
- 为抵抗 `chat.history` 不返回 runId，Dashboard 保存每会话最多 500 条
  `{timestamp, textHash, runId}` 索引；不重复保存回答正文。
- 历史恢复要求文本哈希相同且时间差不超过 5 秒；匹配项一次性消费，避免相同回答串线。
- 仅 Agent 非流式回复显示非零数字徽标。点击后合并同一 runId 的工具、Skills 和可信审查。

限制：升级前已经存在、且没有 runId 绑定索引的旧聊天不会补造执行徽标。

## 5. 排障

| 现象 | 检查 |
|------|------|
| 回复无徽标 | 确认该回复升级后生成、存在 `executionRunId`，且 summary 的工具/Skill 非零 |
| 工具一直“已调用” | 检查 OpenClaw 是否为该内建工具发出 `after_tool_call`；不得手工改成“完成” |
| Skill 漏记 | 检查实际读取路径是否在 research-plugins 权威索引；再检查 `_pluginRoot` 初始化 |
| Skill 误记 | 核对 canonical realpath；未登记文件必须无记录 |
| 刷新后徽标消失 | 检查会话 localStorage 的 `rc-execution-bindings:*` 与 history 时间戳 |
| 清理后其他窗口未更新 | 检查 `plugin.supervisor.review.cleared` 广播和 listener 重载 |

## 6. 发布验收

1. Core：新装与 v17 迁移到 schema 20；快捷指令、工具追踪、Skill 精确识别测试通过。
2. Supervisor：total、显式全量清理、广播、同 runId review 查询测试通过。
3. Dashboard：CRUD、IME、回复绑定、详情弹层和中英文语义测试通过。
4. 真实 Chromium：光标插入后 undo 恢复原文本，redo 恢复插入结果。
5. 三个构建入口均成功；现有全量回归无新增失败。
