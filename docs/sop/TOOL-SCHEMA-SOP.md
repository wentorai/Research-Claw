# Agent Tool Schema 开发 SOP v1.0

> 2026-03-18 — 根据 monitor_report HTTP 400 事故 + OC schema 管线分析制定

## 1. 背景

RC 的 41 个 agent tools 使用手写 JSON Schema 定义参数。
Schema 在 agent 启动时被 OC 原样发送给 LLM API。
**一个 tool schema 不合规 → 整个 agent 请求 HTTP 400 → 全部功能瘫痪。**

## 2. 安全子集规则（5 条铁律）

以下规则来自 Anthropic / OpenAI / Gemini / xAI 四大 provider 的交集验证：

| 规则 | 说明 | 违反后果 |
|------|------|----------|
| **R1** | `type: "array"` 必须有 `items` | HTTP 400（Anthropic/OpenAI） |
| **R2** | `type` 必须是单个字符串，不能是数组 | HTTP 400（OpenAI Strict）、未来 provider 可能拒绝 |
| **R3** | 顶层 `parameters` 必须是 `type: "object"` | HTTP 400（所有 provider） |
| **R4** | `enum` 必须是非空数组 | HTTP 400（所有 provider） |
| **R5** | `required` 中的字段必须存在于 `properties` 中 | HTTP 400（所有 provider） |

## 3. 允许但无效的关键字

以下关键字是合法 JSON Schema，OC 会为 Gemini/xAI 自动剥离，对 Anthropic/OpenAI 透传但不执行：

```
minLength, maxLength, minimum, maximum, pattern, default,
maxItems, minItems, uniqueItems, format, multipleOf
```

**可以使用**（作为文档意图），但**不要依赖它们做运行时校验**。所有实际验证必须在 `execute()` 中实现。

## 4. 表达 nullable 字段的正确方式

```typescript
// ❌ 错误 — type 数组违反 R2，部分 provider 拒绝
deadline: { type: ['string', 'null'], description: '...' }

// ✅ 正确 — 纯 string，在 description 中说明清除方式
deadline: { type: 'string', description: 'ISO 8601 deadline (empty string to clear)' }

// execute() 中处理：
const clearable = (v: unknown): string | null | undefined =>
  v === null || v === '' ? null : typeof v === 'string' ? v : undefined;
```

## 5. 开发 Checklist（每个新 tool）

```
□ type:"array" 都有 items
□ type 都是单个字符串（不是数组）
□ 顶层 parameters 是 type:"object" + properties
□ enum 非空
□ required 字段都在 properties 中
□ 嵌套 object（非顶层）有 properties 或 additionalProperties
□ nullable 字段用 type:"string" + description "(empty string to clear)" + execute 用 clearable()
□ 跑 tool-schema-compliance.test.ts 全绿
□ execute() 中对所有参数做防御性类型检查（typeof guard + null/undefined fallback）
```

## 6. 自动化门禁

`test/tool-schema-compliance.test.ts` 是静态分析测试，覆盖 R1-R5。

```bash
# 每次修改 tools.ts 后必跑
npx vitest run test/tool-schema-compliance.test.ts
```

该测试从源码中提取所有 tool schema 并逐一校验，无需运行时依赖（不需要 better-sqlite3 或 service 实例）。

## 7. OC Schema 管线参考

OC 在发送 tool schema 到 API 前会经过以下处理：

```
Tool.parameters (原始 schema)
  → normalizeToolParameters()    # 扁平化 anyOf/oneOf，补 type:"object"
  → clean-for-gemini.ts          # 剥离 Gemini 不支持的关键字
  → clean-for-xai.ts             # 剥离 xAI 不支持的约束
  → anthropic-stream-wrappers.ts # Anthropic ↔ OpenAI 格式互转
  → LLM API
```

**OC 不会修复的问题：** 缺少 items、type 数组、空 enum。这些必须在我们的 schema 源码中保证正确。

## 8. 参考文件

| 文件 | 用途 |
|------|------|
| `test/tool-schema-compliance.test.ts` | 自动化 schema 合规门禁 |
| `openclaw/src/agents/pi-tools.schema.ts` | OC schema 标准化逻辑 |
| `openclaw/src/agents/schema/clean-for-gemini.ts` | Gemini 不支持关键字清单 |
| `openclaw/src/agents/schema/clean-for-xai.ts` | xAI 不支持关键字清单 |
