# 科研群组验收

科研群组位于左侧文献库上方。团队保存角色、模型和协作顺序，每个新会话使用创建时的团队配置。共享群聊、成员私聊和群组记忆各自保存。

## 手动验收

1. 更新 Core 和 Dashboard 后重启网关进程。打开科研群组，确认进入页面只读取记录。创建默认团队，确认包含院士 AI、教授 AI、小导师 AI 和科研龙虾。
2. 调整角色职责、模型和协作顺序，创建新会话。分别测试选择单一成员、以 `@成员` 开头和勾选协作推进。核对群聊发言、各步骤执行记录及 Jobs 状态。
3. 在协作仍有排队步骤时发送新需求，再对排队步骤选择“补充约束”。新需求应独立排队，补充应随现有流程的后续步骤执行。
4. 让任务请求一个用户决策，回答后观察流程继续。停止排队任务应立即生效，停止运行任务由网关确认。连接丢失或网关重启时，未确认的运行留在待确认状态。
5. 新建第二个会话，检查聊天记录为空。显式引用同团队的共享会话，再检查成员私聊和私有记忆的范围。关闭共享记忆继承，检查新会话的上下文。
6. 检查团队置顶、分组、归档与恢复，以及会话重命名和删除。删除会话前先处理未完成任务，删除后核对群聊记录、磁盘成果和 OpenClaw 执行日志。

## 自动验收

使用仓库要求的 Node.js 和 pnpm 版本。

```sh
pnpm build
pnpm --filter @research-claw/core exec vitest run src/__tests__/teams.test.ts src/__tests__/team-collaboration.test.ts src/__tests__/team-runtime.test.ts src/__tests__/jobs.test.ts src/__tests__/plugin-contract.test.ts
pnpm --filter dashboard exec vitest run src/components/teams src/components/LeftNav.product-policy.test.tsx src/components/panels/JobsPanel.test.tsx
```

可在测试网关上运行 `node scripts/verify-team-collaboration.mjs --pipeline`。该脚本调用配置的模型并创建测试团队，成功后将团队归档。

## 运行范围

- 群任务由本地网关执行，同一时刻运行一个群任务。协作由用户配置为 1–8 个顺序步骤。
- 任务使用已有工具授权和工作区。成员私聊与群聊的上下文分开保存，工具和文件访问权限仍由网关管理。
- 群组和成员记忆由用户显式保存。执行时仅装入有界的近期群消息、同任务交接和记忆摘录。
- 团队支持归档，会话删除会移除群组内记录。网关执行日志和工作区成果遵循各自的保留规则。
