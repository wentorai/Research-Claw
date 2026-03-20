# Bug：设置面板修改模型后值被自动重置回旧值
# Bug: Settings panel model changes silently reverted to the previous value

## 问题概述 / Summary

在 Dashboard 设置面板中修改"文本端点"（模型名称）后，修改的值会被自动重置为服务端保存的旧值，导致用户无法正常切换模型。

When changing the "Text Model" field in the Dashboard Settings panel, the new value is silently reverted to the server-persisted value, preventing users from switching models.

## 环境信息 / Environment

- 操作系统 / OS: macOS（Apple Silicon）
- 项目版本 / Project version: Research-Claw v0.5.5
- Dashboard 框架 / Dashboard framework: React + Ant Design (AutoComplete)
- 复现时的模型配置 / Model config during reproduction: `minimax-cn/MiniMax-M2.7-highspeed`

## 复现步骤 / Reproduction

1. 在设置面板中选择 MiniMax（国内）作为供应商。
   Select MiniMax (国内) as the provider in the Settings panel.

2. 在文本端点字段中手动输入或选择一个不同的模型（如将 `MiniMax-M2.7-highspeed` 改为 `MiniMax-M2.5-highspeed`）。
   Manually type or select a different model in the Text Model field (e.g. change `MiniMax-M2.7-highspeed` to `MiniMax-M2.5-highspeed`).

3. 在点击"保存"之前，值可能已经被自动重置回旧值。
   Before clicking "Save", the value may have already reverted to the old value automatically.

## 原因分析 / Why this happens

### 主因：`useEffect` 无条件覆盖表单状态

`SettingsPanel.tsx` 中有一个 `useEffect`，依赖 `gatewayConfig`（从 Zustand store 获取的服务端配置对象）。每当 `gatewayConfig` 引用变化时，该 effect 会**无条件**地用服务端值覆盖所有表单字段，包括用户正在编辑的 `textModel`：

```tsx
useEffect(() => {
  if (!gatewayConfig) return;
  const fields = extractConfigFields(gatewayConfig);
  setTextModel(fields.textModel);     // ← 覆盖用户编辑
  setProvider(...);
  setBaseUrl(...);
  // ... 所有字段都被重置
}, [gatewayConfig]);
```

### 触发时机

`gatewayConfig` 会在以下情况下被更新（每次都创建新的对象引用）：

1. **WebSocket 断连重连** — `GatewayClient` 内置自动重连机制。每次 `onHello` 回调触发时，都会调用 `loadGatewayConfig()`，创建新的 `gatewayConfig` 对象。
2. **`evaluateConfig` 重试循环** — 当配置验证失败时，最多会以 2 秒间隔重试 5 次，每次重试都会调用 `loadGatewayConfig()`。
3. **手动点击"刷新"按钮** — 直接调用 `loadGatewayConfig()`。

The `useEffect` unconditionally overwrites all form fields whenever `gatewayConfig` changes. `gatewayConfig` gets a new object reference on every WebSocket reconnection (via `onHello` → `loadGatewayConfig()`), on config evaluation retries, and on manual refresh clicks.

### 附加问题：MiniMax 预设模型过时

`provider-presets.ts` 中 MiniMax 的预设模型列表只包含 M2.5 系列，缺少 2026-03-18 新发布的 M2.7 系列。当用户手动输入 `MiniMax-M2.7-highspeed` 时，AutoComplete 的 `filterOption` 无法匹配任何预设选项，下拉菜单为空，用户无法通过下拉菜单发现正确的模型名称。

The MiniMax model presets only contained M2.5-series models, missing the M2.7-series released on 2026-03-18. When a user manually typed a model name not in the presets, the AutoComplete dropdown showed no options, making it difficult to discover available models.

## 修复方案 / What was fixed

### 1. `dashboard/src/components/panels/SettingsPanel.tsx`

引入 `syncNeeded` ref 控制何时允许服务端配置同步到表单：

Introduced a `syncNeeded` ref to control when server config is synced into form fields:

- **初始加载**：`syncNeeded` 初始值为 `true`，首次加载配置时同步表单，然后置为 `false`。
  On mount, `syncNeeded` starts as `true`; the first config load syncs the form, then sets it to `false`.

- **编辑期间**：WebSocket 重连触发的 `loadGatewayConfig()` 会更新 `gatewayConfig`，但 `useEffect` 检查 `syncNeeded.current` 为 `false` 时跳过同步，保护用户编辑。
  During editing, reconnection-triggered config reloads are skipped because `syncNeeded.current` is `false`.

- **手动刷新**：点击"刷新"按钮时先设置 `syncNeeded.current = true`，再调用 `loadGatewayConfig()`，确保同步。
  The Refresh button sets `syncNeeded.current = true` before reloading, ensuring the sync runs.

- **保存后**：`config.apply` 成功后设置 `syncNeeded.current = true`，网关重启后的配置重载会正确同步新值。
  After a successful save, `syncNeeded.current = true` is set so the post-restart config reload syncs the new values.

同时为文本模型和视觉模型的 AutoComplete 组件添加了 `allowClear` 属性，允许用户一键清空字段后重新从下拉菜单选择。

Also added `allowClear` to both text model and vision model AutoComplete components, allowing users to clear the field and re-select from the dropdown.

### 2. `dashboard/src/utils/provider-presets.ts`

为 MiniMax（国际版和国内版）预设新增 M2.7 系列模型：

Added M2.7-series models to both MiniMax presets (International and 国内):

- `MiniMax-M2.7` — MiniMax M2.7
- `MiniMax-M2.7-highspeed` — MiniMax M2.7 Highspeed

新模型排在列表最前面，选择 MiniMax 供应商时 M2.7 会作为默认模型自动填入。

The new models are placed at the top of the list so they become the default when selecting MiniMax as provider.

## 验证结果 / Verification

1. 在浏览器中打开 Dashboard 设置面板。
   Opened the Dashboard Settings panel in the browser.

2. 将模型从 `MiniMax-M2.7-highspeed` 修改为 `MiniMax-M2.5-highspeed`。
   Changed the model from `MiniMax-M2.7-highspeed` to `MiniMax-M2.5-highspeed`.

3. 点击"保存" → 确认重启 → 网关重启完成。
   Clicked Save → confirmed restart → gateway restart completed.

4. 验证配置文件 `config/openclaw.json` 中 `model.primary` 已更新为 `minimax-cn/MiniMax-M2.5-highspeed`。
   Verified `config/openclaw.json` shows `model.primary: minimax-cn/MiniMax-M2.5-highspeed`.

5. 点击"刷新"按钮后，模型字段保持 `MiniMax-M2.5-highspeed`，未被重置。
   After clicking the Refresh button, the model field retained `MiniMax-M2.5-highspeed` without reverting.
