---
doc: engineering/install-startup.md
audience: 开发者 — 渠道 B(仓库按需阅读,不注入运行时)
status: 现行 · 2026-07-29
source-of-truth: 安装流程以根 docs/sop/INSTALL_SOP.md(v2.5)为准;本文只补 RC 特有设计取舍
baseline: OpenClaw 2026.6.1 · DB SCHEMA_VERSION 16
---

# 安装与启动(RC 特有设计)

> **完整安装/调试步骤看根文档**:[`docs/sop/INSTALL_SOP.md`](../../../docs/sop/INSTALL_SOP.md)(install.sh v2.5)与 `INSTALL_DEBUG_SOP.md`。本文**不复制**那些步骤,只记录 RC 作为 OpenClaw 卫星仓在安装/启动上**特有**的设计与理由。

## 1. 安装模型:卫星而非 fork

RC 把 OpenClaw 当 **npm 依赖**消费,**不是 fork**。全部定制走 config overlay + Plugin SDK + 极小 pnpm patch(~20 行/7 文件)。这决定了安装的几条特性:

- **目标平台**:macOS(darwin arm64/x64)、Linux(x64/arm64)、WSL2,以及通过 Docker Desktop 运行的 Windows(x64/arm64)。原生 Windows 不直接运行 POSIX 安装器,使用 `scripts/install-docker.ps1`。
- **运行时**:Node.js ≥ 22.12,pnpm ≥ 9.15;gateway 跑在 conda `openclaw` 环境(Node 22),**不是系统 Node**。
- **脚本幂等**:POSIX 脚本使用严格错误处理,PowerShell 脚本使用 `$ErrorActionPreference = "Stop"`;安装、更新和重新启动均通过同一份 `scripts/ensure-config.cjs` 做版本迁移,重复运行不覆盖用户的有效配置。

## 2. pnpm patch 生命周期(核心 why)

- patch 文件 **版本锁定**:`patches/openclaw@2026.6.1.patch`,随 OC 版本号绑定。
- patch **随 git 提交**:fresh clone `pnpm install` 时 pnpm 自动应用 → 全新克隆即带 branding,无需额外步骤。
- **失败即响**:OC 版本与 patch 不匹配时 pnpm 硬报错,绝不静默吞掉(避免"装上了但 branding 没生效"的隐性坏状态)。
- 升级 OC = 跑 `sync-upstream.sh`(更新依赖)+ `apply-branding.sh`(重生成 patch)+ 测试。patch 只改字符串字面量、不改逻辑,所以重打成本可控(耦合层 L3,见 [architecture.md](./architecture.md) §3)。

## 3. 版本号整数比较(避坑 why)

Node 版本检查对 `major.minor` 拆分后做**整数比较**,而非字符串比较——否则会踩字典序坑(字符串里 `"9" > "22"`)。解析时去掉前导 `v`,取第一个 `.` 前为 major、首尾两个 `.` 之间为 minor。

## 4. 启动:SIGUSR1 自重启循环(核心 why)

- gateway 在**配置变更后**(API key、模型等保存)给自己发 **SIGUSR1 并退出**,期待外部 supervisor 重启它。
- `scripts/run.sh`(本地)与 `scripts/docker-entrypoint.sh`(容器)就是这个重启循环:`Gateway exited (code N) — restarting in 3s`。
- 为什么这样设计:config 热改后需要干净重载,用"退出 + 外层循环拉起"比进程内热重载更简单可靠;也解释了为何改 config 会看到 gateway 短暂重启。

## 5. 配置文件

- `config/openclaw.json`(active)+ `config/openclaw.example.json`(带注释的参考模板)。
- example config **必须能过 OC schema 校验**——非法 key 会让所有新用户启动即崩(集成细节见 [plugin-integration.md](./plugin-integration.md) §2)。
- `scripts/ensure-config.cjs` 是跨阶段迁移的唯一入口:清理历史占位渠道和无效 Supervisor 测试模型,默认关闭需要向外部服务发送内容的语义记忆检索,同时保留用户明确配置过的真实渠道、模型和其他用户自定义值。全局 OpenClaw 配置只执行其既有的兼容迁移,不会注入 RC 插件或语义记忆默认值。

## 6. 版本可见性与升级保护

- 原生安装、`pnpm serve`、源码更新与 Docker 启动都调用 `scripts/version-info.cjs`,终端会显示 Research-Claw、OpenClaw 和当前提交。
- `curl | bash` 安装完成后直接进入 `scripts/run.sh`,不再维护第二套网关循环;端口、单实例锁、配置迁移、定时任务迁移和版本展示只有一个生产入口。
- 摄像头和 RTSP 依赖的 FFmpeg 在 Linux/WSL 与 Docker 中自动安装;macOS 已有 Homebrew 时自动安装,缺少 Homebrew 时明确提示人工补装而不伪装为可用。
- Dashboard 握手携带自身构建版本。升级后仍打开旧页面时,网关会明确要求刷新,避免旧前端悄悄连接新后端。
- Docker 更新先拉取镜像,再把旧容器保留为回退副本。新容器通过 `/healthz` 后才删除旧容器;启动失败、立即退出或健康检查超时时自动恢复旧版本。
- `scripts/reconcile-cron-upgrade.cjs` 在网关启动前只处理可明确识别为 RC 预设的任务:删除已禁用/已删除的遗留任务,并把启用任务的内部投递改为 `mode=none`;用户自行创建的定时任务不改。

---

> 相关:安装/调试全流程见根 [`INSTALL_SOP.md`](../../../docs/sop/INSTALL_SOP.md);耦合层与 patch 范围见 [architecture.md](./architecture.md);插件装载见 [plugin-integration.md](./plugin-integration.md);文档体系导航见 [../00-reference-map.md](../00-reference-map.md)。
