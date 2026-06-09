---
doc: engineering/install-startup.md
audience: 开发者 — 渠道 B(仓库按需阅读,不注入运行时)
status: 现行 · 2026-06-09 瘦身重建(仅留 RC 独有 why,安装步骤链到根 SOP)
source-of-truth: 安装流程以根 docs/sop/INSTALL_SOP.md(v2.5)为准;本文只补 RC 特有设计取舍
baseline: OpenClaw 2026.6.1 · DB SCHEMA_VERSION 14
---

# 安装与启动(RC 特有设计)

> **完整安装/调试步骤看根文档**:[`docs/sop/INSTALL_SOP.md`](../../../docs/sop/INSTALL_SOP.md)(install.sh v2.5)与 `INSTALL_DEBUG_SOP.md`。本文**不复制**那些步骤,只记录 RC 作为 OpenClaw 卫星仓在安装/启动上**特有**的设计与理由。

## 1. 安装模型:卫星而非 fork

RC 把 OpenClaw 当 **npm 依赖**消费,**不是 fork**。全部定制走 config overlay + Plugin SDK + 极小 pnpm patch(~20 行/7 文件)。这决定了安装的几条特性:

- **目标平台**:macOS(darwin arm64/x64)+ Windows(x64/arm64)。脚本也接受 Linux 以兼容 OC,但 Linux **非官方支持平台**。
- **运行时**:Node.js ≥ 22.12,pnpm ≥ 9.15;gateway 跑在 conda `openclaw` 环境(Node 22),**不是系统 Node**。
- **脚本幂等**:`scripts/` 下脚本均 `set -euo pipefail`,跑两次结果一致、不损坏。

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

---

> 相关:安装/调试全流程见根 [`INSTALL_SOP.md`](../../../docs/sop/INSTALL_SOP.md);耦合层与 patch 范围见 [architecture.md](./architecture.md);插件装载见 [plugin-integration.md](./plugin-integration.md);文档体系导航见 [../00-reference-map.md](../00-reference-map.md)。
