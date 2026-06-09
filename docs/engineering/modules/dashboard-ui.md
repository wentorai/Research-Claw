---
doc: engineering/modules/dashboard-ui.md
audience: 开发者 / 前端 — 渠道 B(仓库按需阅读,不注入运行时)
status: 现行 · 2026-06-09 依代码重建(原 03e dashboard 实现设计)
source-of-truth: 代码优先(research-claw/dashboard/src/);本文保留技术取舍 why,组件/store 清单以代码为准
baseline: OpenClaw 2026.6.1 · WS RPC v3 · DB SCHEMA_VERSION 14
---

# Dashboard 实现(前端工程)

> Dashboard 是本地 SPA,经 WebSocket 连本机 gateway。本文讲**技术栈与连接层为什么这样选**;交互哲学看 [../interaction-design.md](../interaction-design.md),组件清单看 `dashboard/src/`(见 §5)。

## 1. 技术栈理由

| 层 | 选择 | 为什么 |
|----|------|--------|
| UI 框架 | React 18 | 与 Web Platform 共用技术栈,知识/组件可复用 |
| 构建 | Vite 6+ | HMR 快、ESM 原生、配置简单 |
| 组件库 | Ant Design 5 | 组件全、原生暗色主题、`antd-style` 做 CSS-in-JS |
| 样式 | antd-style + CSS 自定义属性 | 与 Web Platform 共享 design token,支持主题切换 |
| 状态 | Zustand 5 | 轻量、TS 优先、无样板 |
| Markdown | react-markdown + remark-gfm | 标准 + GFM 扩展 |
| 代码高亮 | Shiki | 准、主题感知、可懒加载 |
| i18n | react-i18next | 行业标准、JSON 资源、命名空间 |

### 为什么不用 Lit(OpenClaw 自带)

OC 内建 UI 用 Lit web components,RC 选 React:
- Web Platform 团队已用 React——共享知识与组件;
- Ant Design 5 开箱即给完整暗色组件集;
- HashMind design token 是 CSS 自定义属性,**框架无关**,换 React 不丢主题;
- React 在 markdown 渲染、虚拟滚动、i18n 上生态更成熟。

### 为什么不用 UmiJS(Web Platform 用的)

Web Platform 用 UmiJS Max 跑多页 + 路由 + SSR 提示 + proxy。Dashboard 是本地 SPA、只有两个视图(Setup Wizard + Workbench),UmiJS 是杀鸡用牛刀,Vite 已够。

## 2. 连接层:GatewayClient

- Dashboard **唯一**与 gateway 通信的出口是 `GatewayClient`(WS RPC v3,见 [../architecture.md](../architecture.md) §4)。**store 不直接碰 gateway**——store 调 client,client 管帧/握手/重连,职责分明。
- **设备鉴权(device auth)**:首连走 challenge → 设备 token,token 存本地;之后用 token 握手。绑定本机设备而非账号密码,契合"本地、无云"威胁模型(gateway 只绑 `127.0.0.1`,见 [../architecture.md](../architecture.md) §8)。

## 3. 重连:指数退避(核心 why)

- 断线后**指数退避重连**(间隔逐次翻倍,带上限),而非定频狂连——gateway 重启(如 config 改动触发 SIGUSR1 自重启,见 [../install-startup.md](../install-startup.md) §4)期间狂连只会刷爆日志、抢 CPU。
- 重连后经 **seq + state.snapshot 做缺口恢复**:不是丢掉全部本地状态重拉,而是补齐断线期间漏掉的事件(协议见 [../architecture.md](../architecture.md) §4)。

## 4. 三层存活性(liveness)

连接"活着"分三层判断,任一层失效给用户不同提示:WS 物理连接 → 握手完成(hello-ok)→ 业务心跳。详见 [../architecture.md](../architecture.md) §7。为什么要分层:物理连上 ≠ 能用,握手没过就发业务请求会被拒;分层才能给"连接中/已就绪/已断"的准确状态。

## 5. 易变事实的权威源

| 想知道 | 去哪数 |
|--------|--------|
| 组件/面板清单 | `dashboard/src/components/` 与 `components/panels/` |
| store 清单 | `dashboard/src/stores/` |
| LeftNav 导航段 | `components/LeftNav.tsx` 的 `PanelTab` |
| RPC 帧/握手/重连实现 | `GatewayClient`(`dashboard/src/` 连接层) |
| design token | `docs/FRONTEND_DESIGN_SYSTEM.md`(HashMind) |

---

> 相关:交互哲学与布局见 [../interaction-design.md](../interaction-design.md);WS 协议与 liveness 见 [../architecture.md](../architecture.md);卡片渲染见 [cards.md](./cards.md);测试纪律见 [../qa-test-spec.md](../qa-test-spec.md);文档体系导航见 [../../00-reference-map.md](../../00-reference-map.md)。
