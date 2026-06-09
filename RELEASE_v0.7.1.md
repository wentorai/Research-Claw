# Research-Claw v0.7.1

> 科研龙虾 v0.7.1 — built as an OpenClaw satellite.
> OpenClaw base: `2026.6.1` · Protocol v3 · Date: 2026-06-09

维护性发布:在 v0.7.0 基础上修复 Dashboard 多处交互问题、恢复微信扫码登录、强化心跳会话与工作区软链行为。

## What's New

### Features
- **微信通道升级官方 2.4.4** —— 同步上游 `@tencent-weixin/openclaw-weixin` 2.4.4,并恢复 Dashboard 网页二维码扫码登录。
- **心跳会话隔离** —— 启用 `isolatedSession`,心跳会话不再污染会话列表(列表中隐藏)。
- **设置面板常驻保存栏** —— 底部常驻保存栏,无改动时禁用保存;内置技能 OFF 项置顶重命名,精简保存/重启提示文案。

### Fixes
- **通道状态** —— 未配置的通道不再误显示为错误状态;通道增删与重连时剔除 OC 拒绝的 `plugins.installs` 键。
- **输入框卡死** —— 运行快速失败时复位 `sending` 状态,避免输入框卡住。
- **配置构建器** —— 修正两处错误默认值。
- **供应商选择器** —— 移除与"添加自定义 API 配置"重复的自定义卡。
- **布局/溢出** —— 论文评审结论整行换行避免溢出;历史输入气泡改用 portal 定位避免被裁剪。
- **设置控件视觉** —— 开关改用 Switch,统一开关与分段控件视觉。
- **工作区软链** —— `MEMORY.md` 软链改用相对路径,避免跨环境失效。

### Housekeeping
- **ppt-master 升级至 v2.9.0** —— 适配导出路径,Python 基线提升至 3.10+ 并增加预检。
- **PPT 集成路径** —— 按仓库根解析 `ppt-master` 路径,修复集成路径不完整。
- **Bootstrap 模板** —— 对齐工具与技能计数(任务 11 / 技能 433 / 本地 47)。
- **自描述** —— 为 Research-Claw 补充规范化自我描述。
- research-plugins 同步至 **v1.4.7**(433 skills + 18 agent tools)。

## Upgrade

```bash
curl -fsSL https://wentor.ai/install.sh | bash
```
