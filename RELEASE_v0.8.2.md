# Research-Claw v0.8.2

> 科研龙虾 v0.8.2 · OpenClaw 2026.6.1 · 2026-08-01

v0.8.2 聚焦“可信执行”与长任务可靠性：用户可以看清 Agent 真正调用了哪些工具和技能，长时间运行在刷新、断线和会话切换后也能依据 OpenClaw 真实会话状态恢复。

## 用户可见改进

- 聊天回复可展开查看执行细节，工具使用和技能激活证据会随 Run 持久化，刷新后仍可追溯。
- Supervisor 增加复审历史生命周期管理，对深度复审结果和不可用原因给出面向用户的明确说明。
- 快捷命令编辑器支持本地预设的新建、编辑、删除和排序，常用研究提示可直接复用。
- 原生技能安装中心统一显示渐进式技能注册表与 OpenClaw 实际加载状态，支持受控的外部技能包安装。
- 聊天附件选择器已通用化，文件与工作区内容的引用路径更一致。
- 长任务与 Jobs 使用 OpenClaw 会话状态作为权威事实，可在重连、跨会话和 RPC 失败后恢复正确的运行范围，并保留首轮消息与会话标题。
- 长任务界面移除无事实依据的伪进度，改为展示可验证的活动、中止和恢复状态。
- Dashboard 表单、对话框与远程输入进一步修复 CJK IME 组合输入、菜单收起和 Plaud 断开确认时序。

## 安全与运维

- 外部技能安装在写入前执行安全预检、归档上传约束和可信执行生命周期校验。
- 新增用户、开发者与支持排障三种日志 profile；`pnpm support` 在退出时生成脱敏诊断包，不改动用户的持久配置。
- 安装器固定使用 pnpm 10.34.4，并保留现有一小时 Agent 运行超时迁移。

## 验证口径

- Node.js 22 下 Dashboard 与根仓测试全部通过。
- 所有 extension 与 Dashboard 构建通过，并完成版本门禁、RPC 错误分类、运行时自检、日志 profile 和 Docker 配置验证。
- 容器验收确认 amd64 + arm64 manifest、healthz、Research-Plugins catalog 及持久化目录。

## 升级

macOS / Linux / WSL2:

```bash
curl -fsSL https://wentor.ai/install.sh | bash
```

Docker:

```bash
curl -fsSL https://wentor.ai/docker-install.sh | bash
```

Windows PowerShell:

```powershell
irm https://wentor.ai/docker-install.ps1 | iex
```
