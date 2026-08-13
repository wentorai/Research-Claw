---
doc: engineering/logging-profiles.md
audience: 用户支持与开发者
status: 现行 · 2026-07-31
baseline: Research-Claw 0.8.1 · OpenClaw 2026.6.1
---

# 启动日志 profile 与排障边界

## 四个彼此独立的概念

| 概念 | 控制项 | 作用 |
|---|---|---|
| Gateway 文件日志 | `logging.level` | 写入持久日志文件的最低等级 |
| Gateway 终端日志 | `logging.consoleLevel` | Gateway 写到 stdout/stderr 的最低等级 |
| 启动器产品文案 | `run.sh` / Docker entrypoint | Dashboard 地址、端口冲突、配置失败、诊断入口等可行动信息 |
| Agent 回复详情 | 会话命令 `/verbose off\|on\|full` | 只改变 Agent 回复详情 |

Dashboard Toast、铃铛、通知中心和声音属于产品通知，也不受上述日志等级控制。

## 行为矩阵

| 场景 | 稳定入口 | Gateway console | Gateway file | 启动器 |
|---|---|---:|---:|---|
| 原生安装用户 | `pnpm serve` 或 `pnpm serve:user` | error | info | 只显示必要步骤与可行动提示 |
| 源码开发者 | `pnpm serve` 或 `pnpm serve:developer` | debug | debug | 显示完整启动步骤 |
| Dashboard HMR | `pnpm dev` | debug | debug | Gateway 与 HMR 开发输出 |
| 一次性支持排障 | `pnpm support` | debug | debug | 退出时生成脱敏诊断包 |
| Docker 默认 | 容器 entrypoint | info | info | 正常容器运维输出 |
| Docker 显式 debug/trace | `OPENCLAW_LOG_LEVEL=debug|trace` 或 config | debug/trace | debug/trace | 不覆盖显式选择 |

文件日志默认位于 `~/.research-claw/logs/openclaw.log`;启动器最近两次运行记录位于同目录的 `run-latest.log` 与 `run-prev.log`。Docker 中这些路径必须映射到持久卷。

## 解析优先级

1. 显式 `RC_LOG_PROFILE=user|developer|support`。
2. 有效的 `.research-claw-install.json` → `user`。
3. 已存在但损坏的 marker → 安全降级到 `user`;不因元数据损坏打开 debug。
4. marker 缺失 → `developer`。

安装器首次安装写 marker 并应用 user 默认值；升级只接管旧版本曾写入的精确默认 tuple。用户自定义过 `logging` 时标记为 unmanaged,升级不覆盖。marker 必须位于仓库根部，不能放入会被 `migrate-rc-data-dir.cjs` 迁移的项目 `.research-claw/` 数据目录。不要依赖 TTY、安装目录名或是否存在 `.git`。

`curl | bash` 实际执行的是下载时刻的公网脚本，而不是随后 clone 下来的
`scripts/install.sh`。因此“安装目录里已经有 `mark-native`”不能证明本次安装执行过它。
发布时必须运行 `pnpm verify:installers`，同时验证仓库副本与
`https://wentor.ai/install.sh` 的 SHA-256；公网漂移会直接失败，不能继续宣称
managed native 日志档位已上线。历史漏标安装只通过重新执行安装器补标，不在
`run.sh` 中根据目录名或 `.git` 猜测，避免误判开发仓库。

`OPENCLAW_LOG_LEVEL` 的优先级由 OpenClaw 本身处理，它会同时覆盖 console 与 file。`RC_VERBOSE=1` 只作为兼容入口：显示启动器细节；在 user profile 且没有显式 OpenClaw 环境覆盖时临时使用 info，绝不把 debug/trace 降为 info。

## 一次性支持流程

```bash
cd ~/research-claw
pnpm support
```

复现完成后按 `Ctrl+C`。该命令不修改 `config/openclaw.json`;环境覆盖随进程退出自动消失，并调用 `scripts/diag.sh` 生成脱敏诊断包。把终端显示的 bundle 路径发送给开发者，不要直接发送 active config、Cookie、API key、Webhook、带 userinfo 的代理 URL 或 PEM。

如只需查看日常持久日志：

```bash
tail -50 ~/.research-claw/logs/openclaw.log
```

## 事实、推论与产品决定

### 已由源码与运行确认的事实

- OpenClaw 2026.6.1 的合法等级是 `silent/fatal/error/warn/info/debug/trace`;阈值越靠前越安静。
- `logging.level` 与 `logging.consoleLevel` 在 config 中独立。
- `OPENCLAW_LOG_LEVEL` 同时覆盖两个 sink。
- npm 实际运行入口是 `node_modules/openclaw/dist`,不是本仓的只读上游源码。
- `pnpm serve`、首次安装完成后的启动最终都进入 `scripts/run.sh`;Docker 使用独立 entrypoint。

### 推论

- user 所需的 “console error + file info” 必须由 config 实现，不能靠 `OPENCLAW_LOG_LEVEL`。
- 安装用户和开发者都可能执行 `pnpm serve`,所以命令名不能稳定识别身份。
- 启动失败提示必须由 wrapper 明确打印，否则安静 Gateway console 会隐藏用户所需动作。

### 产品决定

- 用安装器 marker 区分 managed native install 与 source checkout。
- 用显式 profile 提供稳定覆盖与可复制命令。
- support 是一次性进程环境，不写回 active config。
- Docker 保持 info 运维默认，并完整保留显式 debug/trace。

## 安全回归

`pnpm verify:logging` 必须从实际安装的 OpenClaw dist 发出 debug/info/warn/error 探针，验证 console/file 过滤、环境变量双覆盖，并确认 API key、Cookie、Webhook、代理 userinfo 和 PEM sentinel 均未出现在 debug/trace 输出中。`bash scripts/secret-scan.sh --all` 与脱敏诊断包检查仍是发布门禁。
