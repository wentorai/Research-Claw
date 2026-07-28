# Research-Claw v0.8.2

> 科研龙虾 v0.8.2 · OpenClaw 2026.6.1 · 2026-07-29

这是 v0.8.1 的安装可靠性补丁。功能与 v0.8.1 相同。

## 修复

- 修复中国大陆默认安装路径仍依赖 GitHub 子模块、网络不稳定时会在第 5 步中止的问题。
- 从 Gitee 安装主仓时,PPT Master 子模块优先使用其上游文档提供的 AtomGit 镜像;失败时自动回退 GitHub。显式从 GitHub 安装时顺序相反。
- 两个来源都由 Git submodule gitlink 锁定到同一提交,不会因镜像切换而漂移版本。

## 验证

- macOS arm64 隔离 HOME 中,从 Gitee 全新安装 8 步完成。
- PPT Master 从 AtomGit 检出锁定提交 `8ac18bb381a7c62802316354266f558b3ccae1f7`。
- 安装后的 Research-Claw 构建、Research-Plugins 安装和配置幂等复跑通过。
