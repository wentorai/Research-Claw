# Issue：Dashboard 全量 Vitest 30 项失败（测试未跟进产品演进）
# Issue: Dashboard full Vitest run — 30 failing tests (test drift, not product bugs)

## 问题概述 / Summary

在 v0.6.3 冒烟/回归中，`dashboard` 全量 Vitest 结果为 **1221 PASS / 30 FAIL**（约 131s）。失败集中在 6 个测试文件，根因是**测试 mock 与断言未跟上 send 流程、Thinking UI、RPC 参数与 Settings 重启逻辑的产品变更**，并非运行时功能故障。`research-claw-core`（556/556）与聚焦 smoke（55/55）均通过。

During v0.6.3 smoke/regression, the full dashboard Vitest run reported **1221 PASS / 30 FAIL** (~131s). Failures were confined to six test files caused by **stale mocks and assertions** after product changes to the send pipeline, Thinking UI, RPC params, and Settings restart — not production runtime bugs. `research-claw-core` (556/556) and focused smoke (55/55) passed.

## 环境信息 / Environment

- Research-Claw v0.6.3（开发分支）
- Dashboard: Vitest + React Testing Library
- 命令 / Command: `cd dashboard && pnpm test`
- 日期 / Date: 2026-06-06

## 失败清单 / Failure inventory

| # | 文件 | 失败数 | 根因 |
|---|------|--------|------|
| 1 | `src/__tests__/parity/chat-send.parity.test.ts` | 20 | parity config mock 缺少 `useConfigStore`；`send()` 在 `chat.send` 前调用 `syncSystemPromptAppendToGateway()` 抛错，RPC 次数为 0 |
| 2 | `src/__tests__/parity/chat-empty-guard.parity.test.ts` | 3 | 同上；`send('hello')` 期望仅 1 次 RPC，实际还有 `rc.dashboard.setSystemPromptAppend` |
| 3 | `src/__tests__/parity/thinking-blocks.parity.test.tsx` | 4 | `MessageBubble` thinking 默认折叠；测试在 section 内直接断言正文 |
| 4 | `src/__tests__/parity/message-rendering.parity.test.tsx` | 1 | 纯文本消息用 `queryByRole('img')` 误判（Ant Design Copy 等图标渲染为 img） |
| 5 | `src/__tests__/parity/chat-streaming.parity.test.ts` | 1 | 期望 `sessions.usage` 无参；实现已改为 `{ key: toGatewaySessionKey(sessionKey) }` |
| 6 | `src/components/panels/SettingsPanel.test.tsx` | 1 | 重启断言期望 `config.get` 返回的 raw 字符串；实现改为 `serializeConfigForGatewayApply(snapshotConfig)` |

**说明：** 会话中曾记录 `integration-settings-notifications.test.tsx` 在满负载并行下偶发 5s 超时；隔离运行与修复后全量套件均通过。

## 根因分析 / Root cause

### 1. `send()` 前置 system prompt 同步

`chat.ts` 在 `chat.send` 之前调用：

```typescript
await syncSystemPromptAppendToGateway(useConfigStore.getState().systemPromptAppend);
```

parity 测试仅 mock 了 `primaryModelSupportsVision` / `hasImageModelConfigured`，未导出 `useConfigStore`，导致 `getState()` 为 `undefined` 并中断 send 流程。

### 2. Thinking 折叠 UI

`MessageBubble` 将 thinking 内容放在可折叠区域，默认 `thinkingExpanded === false`，`.chat-thinking-content` 未挂载，但 `[data-testid="thinking-section"]` 仍存在。

### 3. `sessions.usage` 会话键

`loadSessionUsage()` 现传入 gateway 规范键 `agent:main:main`（由 `toGatewaySessionKey('main')` 生成）。

### 4. Settings 无操作重启

About 区「重启网关」的 `handleRestart` 使用 `serializeConfigForGatewayApply(snapshotConfig)` 而非透传 `config.get` 的 `raw` 字段。

## 修复方案 / Fix

### 共享 parity config mock

新增 `dashboard/src/__tests__/parity/parity-config-mock.ts`，在 parity send 相关测试中统一提供：

```typescript
useConfigStore: {
  getState: () => ({ systemPromptAppend: '' }),
},
```

并在 `chat-send.parity.test.ts`、`chat-empty-guard.parity.test.ts` 中引用。

### 各文件断言更新

| 文件 | 变更 |
|------|------|
| `chat-empty-guard.parity.test.ts` | `send('hello')` 改为查找 `chat.send` 调用，而非 `toHaveBeenCalledTimes(1)` |
| `thinking-blocks.parity.test.tsx` | 增加 `expandThinkingSection()`，点击 `.chat-thinking-toggle` 后再断言内容 |
| `message-rendering.parity.test.tsx` | 文本-only 用 `queryByAltText('Attached image')` 替代 `queryByRole('img')` |
| `chat-streaming.parity.test.ts` | 期望 `sessions.usage`, `{ key: 'agent:main:main' }` |
| `SettingsPanel.test.tsx` | 重启测试期望 `serializeConfigForGatewayApply(makeGatewayConfig())` |

## 验证结果 / Verification

### 修复前 / Before

```
Test Files  6 failed | 67 passed (73)
Tests       30 failed | 1221 passed (1251)
Duration    ~131s
```

###  targeted 失败文件（修复后）/ Previously failing files (after fix)

```
Test Files  7 passed (7)
Tests       158 passed (158)
Duration    ~25s
```

涉及文件：`chat-send`、`chat-empty-guard`、`thinking-blocks`、`message-rendering`、`chat-streaming`、`SettingsPanel.test`、`integration-settings-notifications`。

### 全量 Dashboard（修复后）/ Full dashboard (after fix)

```
Test Files  73 passed (73)
Tests       1252 passed (1252)
Duration    ~64s
```

命令：

```bash
cd dashboard && pnpm test
```

### 其他层（未变，仍通过）/ Other layers (unchanged, still passing)

| 层 | 结果 |
|----|------|
| `extensions/research-claw-core` | 556/556 PASS |
| `extensions/dual-model-supervisor` | 50/50 PASS |
| `scripts/health.sh` | PASS |

## 相关文档 / Related docs

- 功能测试规格：`docs/functional-test-spec.md`
- 类似测试维护记录：`docs/bugFix/03-ISSUE_config_save_restart_race.md`（Settings save/restart 产品行为）

## 预防建议 / Prevention

1. 修改 `chat.send` 前置步骤或 RPC 签名时，同步更新 `src/__tests__/parity/` 与 `src/stores/chat.test.ts`。
2. 变更 MessageBubble 交互（折叠/展开）时，更新 `thinking-blocks.parity.test.tsx`。
3. CI 中保持 `dashboard` 全量 Vitest 为 merge 门禁；parity 测试 mock 优先复用 `parity-config-mock.ts`。
