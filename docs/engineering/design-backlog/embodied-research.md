---
doc: engineering/design-backlog/embodied-research.md
audience: 开发者 — 渠道 B(设计储备,未进代码)
status: ⛔ 未实现 · 设计储备 · 2026-07-24 创建(外设子系统 T17 占位)
source-of-truth: 本文是**设计设想**,代码中无对应实现(无 oc-node driver 实现 / 无具身设备配对流程 / `embodied` kind 仅作 schema 枚举占位)。落地前此文仅供参考,不代表现状
baseline: 写作时叠加于 OpenClaw 卫星架构 + 外设子系统 v1(camera + Plaud 已落地)
---

# 具身科研智能(design-backlog)

> ⛔ **未实现**。本文是一份**设计储备**:赋予 AI Agent 物理执行能力——通过接入机械臂、移动平台、人形机器人等具身设备,实现实验室巡检、样品取放、操作台直接操控一体化。代码中**尚无任何实现**(无 oc-node driver / 无 OC nodes 配对流程 / `embodied` kind 仅作 schema 枚举占位)。保留此文是为了不丢设计意图;真要落地时以此为起点,但需重新对齐当时的 schema 与依赖。
>
> SPEC 引用:`docs/research-claw/2026-07-23-peripherals-subsystem-design.md` §3.3(多 driver 路由)§9(演进路线 — 具身设备 = oc-node driver)

## 1. 愿景

赋予 AI Agent 物理执行能力:从感知(视觉 / 传感)到执行(机械动作)在同一 Agent 循环中闭合。目标设备:

| 设备类型 | Agent 能力 |
|---------|-----------|
| 机械臂 | 夹取 / 放置样品;操作移液管;拧盖 / 开盖 |
| 轮式移动平台 | 在实验室空间内自主导航;定点取送样品 |
| 人形机器人 | 多步骤操作台任务;跨工作台协作 |
| 无人机 | 高架货架巡检;大型场馆取样 |

核心价值:**物理闭环** — Agent 不仅能读取世界状态,还能直接改变物理世界,真正实现 AI4S 的"实验自动化"愿景。

## 2. 技术路线锚点

### 2.1 OpenClaw nodes 体系(role:node + node.invoke)

具身设备将对接 OpenClaw nodes 体系:

```
OC Node 图
  └── 具身设备节点 (role: node)
        ├── 注册: 配对审批流程 → 写入 OC 节点配置
        ├── 指令发送: node.invoke(nodeId, command, params)
        └── 状态回传: 观测时间线(rc_periph_observations)
```

Agent 调用 `node.invoke` 发送物理指令,执行结果异步回写观测时间线。配对接入须经审批流程(Human-in-Loop),防止未经授权的物理操作。

### 2.2 外设子系统中的位置

与外设子系统的关系(见 SPEC §3.3 多 driver 路由):

| 字段 | 占位值 |
|------|-------|
| `kind` | `embodied` ← 已在 `rc_periph_devices` schema 枚举占位 |
| `driver` | `oc-node` ← 已在 driver 枚举占位 |

落地时通过 driver 层新增 oc-node 分支实现,工具面与 RPC 结构不变,符合"单工具面多 driver 路由"设计原则。

### 2.3 与摄像头桥的演进线关系

具身科研智能与摄像头桥属于**同一条演进线**:

```
摄像头桥(已落地):
  agent 请求一帧 → browser-camera driver → dashboard 桥 → vision 上下文 → 查证

具身设备(本文):
  agent 下指令 → oc-node driver → OC nodes 网络 → 物理执行 → 状态回传
```

摄像头桥已验证了"agent → driver → 物理世界 → 上下文闭环"的基础链路模式。具身模块在此模式上将"读"(抓帧)扩展为"写"(执行动作)。

### 2.4 安全设计原则

具身设备操作有物理不可逆性,安全边界比纯感知设备更严格:

| 操作类型 | 策略 |
|---------|------|
| 状态查询(读) | 自动执行,无需确认 |
| 移动 / 夹取(写,可复位) | 需人工确认 |
| 高风险动作(切割 / 混液等) | 强制 HiL + 二次确认 |
| 紧急停止 | 任何时刻可触发,优先于所有 Agent 指令 |

## 3. 与外设子系统的关系

```
外设面板
├── 摄像头 (driver: browser-camera) ← 已落地
├── Plaud  (driver: mcp-plaud)      ← 已落地
├── 物理实验室 (kind: lab-instrument · driver 走 rtsp 演进线)  ← ⛔ physical-lab.md
└── 具身科研智能 (driver: oc-node)       ← ⛔ 本文
```

定时查证(`rc_periph_monitors`)可用于具身设备的定期巡检任务;观测时间线(`rc_periph_observations`)记录每次物理执行结果,两张表落地时可直接复用。

## 4. 落地前必须重新确认

| 项 | 为什么 |
|----|-------|
| OC nodes API 成熟度 | 当前 OC 版本(2026.6.1)的 `node.invoke` 是否已稳定暴露 / 文档完整需核实 |
| 具身设备通信协议 | ROS 2 / MQTT / gRPC 各机器人平台差异大;需按目标设备选型 |
| 配对审批流程 UI | 需在 Dashboard 中设计设备发现 → 配对申请 → 管理员审批 → 激活的完整 UI 流程 |
| gateway.nodes.* 安全面 | SPEC §9 明确"占位阶段不碰 nodes 安全面",落地前须与 OC 团队对齐安全审计范围 |
| schema 版本对齐 | 落地时按当前 SCHEMA_VERSION 写迁移脚本 |
| HiL 机制的物理延迟容忍 | 等待人工确认期间设备保持安全静止状态的超时处理逻辑 |

---

> 相关:外设子系统总体设计见 `docs/research-claw/2026-07-23-peripherals-subsystem-design.md` §3.3/§9;物理实验室占位见 [physical-lab.md](physical-lab.md);摄像头桥演进见 [engineering/modules/dashboard-ui.md](../modules/dashboard-ui.md);文档导航见 [../../00-reference-map.md](../../00-reference-map.md)。
