---
doc: engineering/design-backlog/physical-lab.md
audience: 开发者 — 渠道 B(设计储备,未进代码)
status: ⛔ 未实现 · 设计储备 · 2026-07-24 创建(外设子系统 T17 占位)
source-of-truth: 本文是**设计设想**,代码中无对应实现(无仪器驱动 / 无 nodeInvokePolicies 注册实现;driver 枚举中并无 lab-instrument 值,仅 kind 枚举占位)。落地前此文仅供参考,不代表现状
baseline: 写作时叠加于 OpenClaw 卫星架构 + 外设子系统 v1(camera + Plaud 已落地)
---

# 物理实验室接入(design-backlog)

> ⛔ **未实现**。本文是一份**设计储备**:把 AI Agent 接入真实科学仪器(培养箱 / 显微镜 / PCR 仪等),赋予其直接读取仪器状态、控制实验流程、记录实验数据的能力。代码中**尚无任何实现**(无仪器驱动模块、无 nodeInvokePolicies 仪器命令注册;`lab-instrument` 仅作 `kind` 枚举占位,driver 枚举中并无该值)。保留此文是为了不丢设计意图;真要落地时以此为起点,但需重新对齐当时的 schema 与依赖。
>
> SPEC 引用:`docs/research-claw/2026-07-23-peripherals-subsystem-design.md` §3.3(多 driver 路由)§9(演进路线)

## 1. 愿景

打通 AI Agent 与真实科学仪器之间的连接通道。目标场景:

| 仪器类型 | Agent 能力 |
|---------|-----------|
| 培养箱 | 实时读取温度 / CO₂ / 湿度状态;异常时触发告警 |
| 显微镜 | 请求捕获当前视野图像;注入 vision 上下文 |
| PCR 仪 | 查询运行进程 / 剩余循环数 / 结束时间 |
| 天平 / 液体处理机 | 读取称量值 / 分液进度 |

核心价值:**实验流程自动化** — Agent 根据实验协议自动推进步骤,测量数据实时写入工作区,无需人工在仪器屏幕与电脑之间反复切换。

## 2. 技术路线锚点

### 2.1 插件 nodeInvokePolicies 注册仪器命令

仪器命令将通过插件的 `nodeInvokePolicies` 机制注册为受策略管控的调用单元:

```
仪器驱动插件
  └── nodeInvokePolicies
        ├── 命令名(e.g. incubator.read, microscope.snap)
        ├── 允许条件(权限范围、设备 ID 白名单)
        └── Human-in-Loop 触发规则(写操作强制确认)
```

每一条仪器操作指令在执行前均经过权限审查 + 人工确认(Human-in-Loop),防止自动化操作引发实验安全风险。

### 2.2 外设子系统中的位置

与外设子系统的关系(见 SPEC §3.3 多 driver 路由):

| 字段 | 占位值 |
|------|-------|
| `kind` | `lab-instrument` ← 已在 `rc_periph_devices` schema 的 kind 枚举占位 |
| `driver` | 走 `rtsp` 演进线 ← driver 枚举当前为 `browser-camera / mcp-plaud / rtsp / oc-node`,**无 `lab-instrument` 值**;落地时扩展 driver 枚举的 CHECK 约束 |

落地时通过 driver 层新增分支实现,工具面(`periph_list` / `periph_camera_snap`)与 RPC 结构(`rc.periph.*`)不变,符合外设子系统的"单工具面多 driver 路由"设计原则。

### 2.3 与摄像头桥的关系

摄像头桥已实现"Agent 请求一帧 → 桥接 → 视觉查证"闭环。物理实验室的**显微镜接入**可复用此链路:显微镜抓帧 → 注入 vision 上下文 → Agent 做视觉判读。差异仅在 driver 层(从 `browser-camera` 换为新增的仪器 driver,预计沿 `rtsp` 演进线扩展)。

## 3. 与外设子系统的关系

```
外设面板
├── 摄像头 (driver: browser-camera) ← 已落地
├── Plaud  (driver: mcp-plaud)      ← 已落地
├── 物理实验室 (kind: lab-instrument · driver 走 rtsp 演进线)  ← ⛔ 本文
└── 具身科研智能 (kind: embodied · driver: oc-node)       ← ⛔ embodied-research.md
```

定时查证(`rc_periph_monitors`)与观测时间线(`rc_periph_observations`)对物理实验室同样适用,落地时可直接复用,无需改表结构。

## 4. 落地前必须重新确认

| 项 | 为什么 |
|----|-------|
| 仪器通信协议选型 | RS-232 / USB-HID / TCP/IP REST / LabVIEW 驱动各有差异;需按目标仪器型号确定 |
| nodeInvokePolicies API 成熟度 | 当前 OC 版本(2026.6.1)的 nodeInvokePolicies 是否已暴露插件接口需核实 |
| 安全边界 | 写操作(控制仪器)必须强制 HiL;读操作可自动化;边界需在策略文件中明确声明 |
| schema 版本对齐 | 落地时按当前 SCHEMA_VERSION 写迁移脚本;禁止直接修改 schema.ts 而不写 migrations.ts |
| driver 枚举扩展 | 落地时需为仪器 driver 新增枚举值并同步更新 driver 列的 CHECK 约束(当前 driver 枚举无 lab-instrument 值) |

---

> 相关:外设子系统总体设计见 `docs/research-claw/2026-07-23-peripherals-subsystem-design.md` §3.3/§9;具身科研智能占位见 [embodied-research.md](embodied-research.md);文档导航见 [../../00-reference-map.md](../../00-reference-map.md)。
