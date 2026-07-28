# Research-Claw v0.8.1

> 科研龙虾 v0.8.1 · OpenClaw 2026.6.1 · 2026-07-29

这是 v0.8.0 的安装与升级可靠性修复版，不改变 Supervisor 的公开能力边界。

## 用户可见改进

- 安装、更新和 `pnpm serve` 会直接在终端显示 Research-Claw、OpenClaw 与当前提交，不再需要进入 Dashboard 猜测版本。
- `curl | bash` 与 `pnpm serve` 现在走同一个启动入口，重复启动不会杀掉正在工作的服务。
- 原生安装与 Docker 镜像都会准备摄像头、RTSP 所需的 FFmpeg；macOS 缺少 Homebrew 时会明确给出补装方法。
- 第二次运行 `pnpm serve` 会识别并复用已启动的服务，不再误杀正在工作的网关。
- 升级会自动清理历史测试模型、无效占位渠道和已撤下配置；真实渠道、模型和其他用户自定义值会保留。
- 历史版本遗留的 Weekly Report 等科研预设任务会在启动时自愈，不再因缺少消息目标而反复失败。
- Docker 更新先保留旧容器；新版本启动或健康检查失败时自动恢复旧版本。
- 浏览器仍缓存旧 Dashboard 时，新网关会明确提示刷新，不再出现前后端版本混用。
- Supervisor 无法调用深度复审时会用用户能理解的文字说明原因；确定性危险命令保护仍独立运行。

## 安全与默认行为

- 新安装默认不启用语义记忆联网检索，避免用户未明确选择时把内容发送到嵌入模型服务。
- 旧 Telegram/Discord 示例配置只在能证明是历史占位符时删除；真实渠道配置不会被迁移脚本误删。
- 定时任务迁移只处理 Research-Claw 自带预设，不改用户自行创建的任务。

## 验证口径

- Node.js 22 下完整构建通过。
- 根仓测试与 Dashboard 测试全部通过。
- 真实隔离网关完成 Dashboard 版本握手、RPC 错误分类、运行时自检与定时任务降级验证。
- 安装脚本覆盖 macOS/Linux/WSL2、Windows Docker 和 POSIX Docker；配置迁移共用同一幂等入口。
- 全部 Git 跟踪文件通过明文密钥扫描。

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
