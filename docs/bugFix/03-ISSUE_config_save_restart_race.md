# Bug：保存配置时"保存失败，网关可能已重启" + 上下文超限断连
# Bug: "Save failed, gateway may have restarted" + context overflow disconnect

## 问题概述 / Summary

用户报告两个问题：
1. 更换模型保存时频繁出现"保存失败 — 网关可能已重启，请重试"
2. 使用 LM Studio 本地部署 deepseek-r1-distill-qwen-14b 时，上下文超限导致自动断连

Two user-reported issues:
1. "Save failed — gateway may have restarted" when switching models
2. Context overflow causes automatic disconnection with LM Studio local models

## 环境信息 / Environment

- Research-Claw v0.5.11
- OpenClaw v2026.3.13
- LLM: LM Studio + deepseek-r1-distill-qwen-14b (14B 本地模型)
- 搜索: Perplexity

## 根因分析 / Root Cause

### Issue 1: contextWindow 默认值过大

`config-patch.ts` 的 `resolveModelDef()` 为不在预设列表中的自定义模型设置 `contextWindow: 128_000`。deepseek-r1-distill-qwen-14b 实际上下文窗口仅 32K，导致：

1. OpenClaw 认为模型支持 128K tokens → 积累过大 prompt
2. LM Studio 尝试处理超出模型能力的 prompt → GPU 内存溢出 → 连接中断
3. OC 的 `isLikelyContextOverflowError()` 无法匹配网络错误（ECONNRESET）→ 不触发 compaction → 死循环

```typescript
// Before: 128_000 — too large for most local models
contextWindow: known?.contextWindow ?? 128_000,
// After: 32_000 — conservative default matching typical local model capacity
contextWindow: known?.contextWindow ?? 32_000,
```

### Issue 2: config.apply 竞态条件

保存配置后 gateway 通过 SIGUSR1 重启。用户在重启完成前再次操作时：
- WS 连接可能已断开 → RPC 失败 → "保存失败"
- `RESTART_COOLDOWN_MS = 30_000` 导致连续保存的重启延迟可达 30s+

## 修复方案 / Fix

### 架构：Zustand Store Flag + 全局 Listener 组件

```
SettingsPanel (Save 按钮)
    │  setPendingConfigRestart(true) → sessionStorage
    │
    ▼
config store (pendingConfigRestart)
    │  Zustand state + sessionStorage 持久化
    │  ✓ 面板关闭/打开（unmount/remount）后状态保留
    │  ✓ 页面刷新后状态保留
    │
    ▼
ConfigRestartListener (全局组件, 不 unmount)
    │  监听 gateway state: !connected → connected
    │  检查 pendingConfigRestart flag
    │  ✓ 触发 toast "重连成功 — 配置已生效"
    │  ✓ 清除 flag → 按钮恢复可用
    ▼
SettingsPanel (读 store flag → 按钮 disabled/enabled)
```

### 关键文件

| 文件 | 改动 |
|------|------|
| `stores/config.ts` | 新增 `pendingConfigRestart` flag + sessionStorage |
| `components/ConfigRestartListener.tsx` | 新建全局 Listener（同 CronEventListener 模式）|
| `App.tsx` | 挂载 ConfigRestartListener |
| `components/panels/SettingsPanel.tsx` | 用 store flag 替换 local `restarting` state |
| `utils/config-patch.ts` | contextWindow fallback 128K → 32K |
| `i18n/*.json` | 新增 `settings.reconnected` |

## 踩坑记录 / Pitfalls

### 1. SettingsPanel 的 unmount/remount 问题

**坑**: SettingsPanel 通过 `{showInlinePanel && <RightPanel />}` 条件渲染。关闭面板 = unmount，所有 React state、useRef、useEffect 全部销毁。重新打开 = 全新实例。

**教训**: 任何需要跨面板关闭/打开保持的状态，**不能用组件级 state/ref**，必须提升到 Zustand store 或 context。

### 2. useEffect 中读取非 deps 的 state 变量

**坑**: `useEffect([gatewayConfig])` 中读取 `restarting` state（不在 deps 中）。在多轮 render 之间，React batching 可能导致 effect 闭包捕获的 `restarting` 值不是最新的。改用 useRef 也无济于事——ref 虽然同步但组件 unmount 后同样被销毁。

**教训**: 如果 effect A 的 deps 和需要读取的状态 B 生命周期不同，不要把 B 塞进 A 的闭包。把它们拆成独立 effect，或提升到 store。

### 3. Safety timeout vs OC RESTART_COOLDOWN_MS

**坑**: 初版设置了 15s safety timeout 来重置 `restarting` 状态。但 OC 的 `RESTART_COOLDOWN_MS = 30_000`，连续保存时 gateway 重启可能延迟 30s+。15s timeout 在 gateway 实际重启前就触发了。

**教训**: 不要用 timer 猜测 gateway 重启耗时。用**事件驱动**：监听 WS `state` 从 non-connected → connected 的转换，这是唯一可靠的"重连成功"信号。

### 4. 正确的"重连成功"信号

**坑**: 尝试用 `gatewayConfig` 引用变化作为信号。但 `gatewayConfig` 在初次 mount、手动 refresh、重连等多个场景都会变化，无法区分。

**教训**: 使用 `useGatewayStore(s => s.state)` 的状态转换 + 一个 flag 组合，而非 config 引用变化。全局 Listener 组件（不 unmount）是最可靠的监听点。

### 5. sessionStorage vs localStorage

**选择**: sessionStorage。

- 关闭 tab → 清除 flag（正确：新 tab 不应看到旧 tab 的重启状态）
- 刷新页面 → 保留 flag（正确：同一 tab session 内重启状态应保持）
- 不同 tab → 独立（正确：每个 tab 有自己的 gateway 连接）

## 测试用例 / Test Matrix

| 场景 | 预期 | 通过 |
|------|------|------|
| Save → 保持 panel 打开 → 等重连 | 按钮 disabled → toast → 按钮恢复 | ✓ |
| Save → 关闭 panel → 等重连 → 打开 panel | toast 出现, 按钮正常 | ✓ |
| Save → 关闭 panel → 打开 panel（重连前）| 按钮仍 disabled | ✓ |
| Save → 刷新页面 → 等重连 | 按钮 disabled → toast → 恢复 | ✓ |
| 正常打开 panel（无 save）| 按钮正常, 无 toast | ✓ |
