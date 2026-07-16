# Research-Claw v0.7.5

> 科研龙虾 v0.7.5 — built as an OpenClaw satellite.
> OpenClaw base: `2026.6.1` · Protocol v3 · Date: 2026-07-16

功能性发布:Monitor 模块新增候选采集与监控更新工具,落地 Job 编排协议与自检步骤,安装流程全面增强(步骤总览、进度打点、可续装、诊断日志),并修复多项安装与运行稳定性问题。

## What's New

### Features

- **Monitor 候选采集** —— 新增监控候选采集器与监控更新工具,支持自动采集候选条目并更新监控状态。
- **监控任务同步** —— 优化定时任务与监控任务的状态同步,监控 dashboard store 全面重构。
- **Job 编排协议** —— 新增 Job 编排协议与自检步骤,补齐任务 RPC 与工具协议。
- **安装体验增强** —— 安装脚本新增步骤总览与进度打点,中断后可续装并给出提示,失败时输出诊断日志。
- **长任务自动提升** —— Dashboard 优化长任务自动提升判断,配套进度卡与代码块展示改进。

### Fixes

- **安装稳定性** —— Git 代理预检与拉取进度心跳;更新走 Gitee 镜像遇 401 不再卡死,补 GitHub 自愈兜底;原生编译失败时给出工具链指引。
- **better-sqlite3 升级 12.x** —— 改用预编译产物,修复 Node 24 下源码编译失败。
- **长连接停滞恢复** —— 放宽停滞恢复阈值,降低误恢复风险。
- **插件信任与加载** —— ensure-config 补齐 browser / research-superpower / core plugin 的信任与加载配置。
- **微信通道** —— 修复通道与账号启用状态同步。
- **配置清理** —— 清理脱敏占位符并保留真实密钥。

### Housekeeping

- 校准 AGENTS 规范与工具数量文档,补充工具路由和长任务规范。
- 设置区 / 配置 patch 相关测试补齐,OpenClaw 同步测试稳定化。
- research-plugins 升级至 **v1.4.8**(433 skills + 18 agent tools,补全插件激活契约)。

## Upgrade

```bash
curl -fsSL https://wentor.ai/install.sh | bash
```
