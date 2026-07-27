---
doc: engineering/qa-test-spec.md
audience: 开发者 / QA — 渠道 B(仓库按需阅读,不注入运行时)
status: 现行 · 全量功能清单与验收用例(唯一 QA 清单)
source-of-truth: 代码 + 飞书使用指南;功能以当前代码实现为准
baseline: OpenClaw 2026.6.1 · DB SCHEMA_VERSION 16
---

# Research-Claw 功能清单与测试用例

> **版本基准：** 当前版本以根 `package.json` 为准 · OpenClaw 2026.6.1  
> **来源：** [飞书《00-科研龙虾使用指南》](https://thesisagent.feishu.cn/docx/EN1Odi3dMoAPW2xkwWVcCAybnFg)、项目 README、`docs/00-reference-map.md` 及当前代码实现  
> **测试入口：** Dashboard `http://127.0.0.1:28789` · Gateway `ws://127.0.0.1:28789`  
> **优先级：** P0 = 阻塞发布 · P1 = 核心功能 · P2 = 增强/边界  
> **左导航顺序（`LeftNav`）：** 文献库 → 工作区 → 评审 → 任务 → 监控 → 质量管控 → 扩展 → 设置  
> **图例：** 【面板】Dashboard 面板 UI · 【Agent】Chat / Agent 工具 · 【两者】均可

---

## 一、功能清单（全量陈列）

### 1. 安装与部署

| ID | 功能 | 说明 |
|----|------|------|
| F-01-01 | 一键安装 | `curl -fsSL https://wentor.ai/install.sh \| bash` |
| F-01-02 | macOS / Linux 原生安装 | Node ≥22、pnpm，脚本 idempotent |
| F-01-03 | Docker 一键部署 | macOS / Linux / Windows 通用 |
| F-01-04 | WSL2 手动安装 | Windows 备选方案 |
| F-01-05 | 版本更新 | install.sh 同命令更新 |
| F-01-06 | 健康检查 | `scripts/health.sh` |
| F-01-07 | 备份 | `scripts/backup.sh`（workspace / config / DB） |
| F-01-08 | 卸载流程 | 文档定义的标准卸载 |
| F-01-09 | 守护进程 / 开机自启 | systemd / launchd / Docker |
| F-01-10 | 品牌 Patch | pnpm patch 覆盖 CLI 名称、进程标题等 |

### 2. 首次启动与 Setup Wizard

| ID | 功能 | 说明 |
|----|------|------|
| F-02-01 | 首次配置向导 | 未配置时全屏 Setup Wizard |
| F-02-02 | 模型供应商选择 | 多 preset：Anthropic、OpenAI、智谱、Kimi、DeepSeek 等 |
| F-02-03 | OAuth 登录 | OpenAI Codex、Gemini 等 OAuth 流程 |
| F-02-04 | API Key 配置 | 本地加密存储，掩码显示 |
| F-02-05 | 自定义 API 端点 | baseUrl + API 协议（OpenAI / Anthropic 兼容） |
| F-02-06 | Ollama 本地模型发现 | 自动拉取 `/api/tags` |
| F-02-07 | 独立视觉模型 | 可选第二套 provider/model/key |
| F-02-08 | 代理配置 | HTTP/SOCKS 代理 URL |
| F-02-09 | 跳过向导 | 「跳过，进入 Dashboard」 |
| F-02-10 | 保存后网关重启 | 自动重连 Dashboard |
| F-02-11 | 对话式引导 | BOOTSTRAP.md 驱动：领域、项目、引用风格等 |

### 3. 网关连接与启动

| ID | 功能 | 说明 |
|----|------|------|
| F-03-01 | WebSocket 连接 | 自动连接 + 指数退避重连 |
| F-03-02 | 网关 Token 认证 | Docker 场景 token 输入 |
| F-03-03 | 连接状态 Banner | 重连中 / 已断开提示 |
| F-03-04 | 本地 loopback 绑定 | 仅 127.0.0.1，无远程暴露 |
| F-03-05 | Control UI 托管 | gateway 提供 dashboard/dist |

### 4. Dashboard 壳层与全局 UX

| ID | 功能 | 说明 |
|----|------|------|
| F-04-01 | 三栏布局 | 左导航 + 中 Chat + 右/上/下配置面板 |
| F-04-02 | 配置面板停靠 | 右 / 左 / 上 / 下 四向 dock；`ConfigPanelDockPicker` 可视化切换 |
| F-04-03 | 面板宽度/高度拖拽 | 左右 320–480px；上下 dock 可拖高度（`configPanelHeight`） |
| F-04-04 | 左导航折叠 | 240px ↔ 56px icon rail；`localStorage` 持久化 |
| F-04-05 | 响应式布局 | xl/lg/md/sm 断点，overlay / 全屏 sheet |
| F-04-06 | 暗色 Terminal 主题 | HashMind 默认 |
| F-04-07 | 暖色 Paper 主题 | 浅色阅读模式 |
| F-04-08 | 中英双语 | react-i18next，500+ keys（`en.json` / `zh-CN.json`） |
| F-04-09 | TopBar | Logo、通知铃、Agent 状态点、主题/语言切换 |
| F-04-10 | StatusBar | 模型名、Token In/Out（`sessions.usage` 按 sessionKey）、心跳、版本、更新提示 |
| F-04-11 | Agent 状态机 | idle / thinking / compacting / tool_running / streaming / error / disconnected |
| F-04-12 | 无障碍 landmark | main / nav / sidePanel |
| F-04-13 | 配置重启监听 | `ConfigRestartListener`：save/restart 后 gateway 重连时刷新 config、清除 pending 状态 |

### 5. 会话管理

| ID | 功能 | 说明 |
|----|------|------|
| F-05-01 | 多会话并行 | 独立 chat history，最多 maxConcurrent（默认 4） |
| F-05-02 | 新建会话 | `project-{uuid}` 或 `/new` |
| F-05-03 | 切换会话 | 下拉列表，搜索过滤 |
| F-05-04 | 重命名会话 | prompt 输入 |
| F-05-05 | 删除会话 | 非 main 会话可删，含 cron 清理 |
| F-05-06 | 主会话保护 | main 不可删除 |
| F-05-07 | 会话帮助 tooltip | 解释并行概念 |
| F-05-08 | 会话过期提示 | 读取 `config.session.reset`（daily/idle）；Chat Banner + 发送前 `Modal.confirm` |
| F-05-09 | 定时任务会话 | cron 专用 session 折叠分组与管理 |
| F-05-10 | Cron 会话删除 | 删除 cron session 时 `removeScheduledJobForSession` 清理 gateway job |

### 6. Chat 对话核心

| ID | 功能 | 说明 |
|----|------|------|
| F-06-01 | 自然语言对话 | 主交互入口，「Chat is the OS」 |
| F-06-02 | Markdown 渲染 | GFM、LaTeX、代码高亮（Shiki） |
| F-06-03 | 流式输出 | delta 累积 + 光标动画 |
| F-06-04 | 思考过程展示 | thinking 区块默认折叠，点击展开 |
| F-06-05 | 图片附件 | 拖拽/选择，5MB 限制，多格式 |
| F-06-06 | 视觉模型路由 | 不支持 vision 时提示切换 |
| F-06-07 | 发送 / 停止 | Enter 发送；Stop 按钮 + 全局快捷键（Esc、macOS ⌃C/⌘./无选区 ⌘C、Win/Linux Ctrl+C） |
| F-06-08 | 中止后恢复输入 | 停止时还原 draft |
| F-06-09 | 会话级 draft 持久化 | localStorage 按 sessionKey |
| F-06-10 | 输入历史 | ↑↓ 浏览 + 历史弹窗 |
| F-06-11 | 刷新对话 | 从 gateway 拉取新消息 |
| F-06-12 | 上下文压缩提示 | compacting banner |
| F-06-13 | 上下文溢出提示 | overflow 引导 /new |
| F-06-14 | 工具调用警告 | 模型不支持 tools 时 banner |
| F-06-15 | 活动日志 | 后台 tool 活动 stream |
| F-06-16 | 复制原文 | 含思维链 + Markdown |
| F-06-17 | Scroll-to-bottom FAB | 未读消息角标 |
| F-06-18 | Chat 预填 | 面板操作 → 填入输入框（含 Workshop「继续到 Chat」） |
| F-06-19 | Docker 文件打开降级 | 下载替代 openExternal |
| F-06-20 | 跨面板工作区预览 | `requestWorkspacePreview(path)`：file_card / 任务 / 评审 → 工作区 Tab + `FilePreviewModal` |
| F-06-21 | 任务流时间线 | `TaskFlowTimeline`：understand / execute / respond 推断步骤 + Agent `task_flow_stage` 显式阶段 |

### 7. Slash 命令（本地 RPC 执行）

| ID | 命令 | 功能 |
|----|------|------|
| F-07-01 | `/compact` | OpenClaw safeguard 压缩；无用户自定义时追加 RC 科研保真指令，已有非空 `customInstructions` 原样保留 |
| F-07-02 | `/new` | 新建会话 |
| F-07-03 | `/stop` | 停止当前 run |
| F-07-04 | `/clear` | 清空聊天记录 |
| F-07-05 | `/model [name]` | 查看/切换模型 |
| F-07-06 | `/think <level>` | off/low/medium/high |
| F-07-07 | `/fast on\|off` | 快速模式 |
| F-07-08 | `/verbose on\|off\|full` | 详细模式 |
| F-07-09 | `/help` | 命令列表 |
| F-07-10 | `/usage` | Token 用量 |

### 8. 结构化消息卡片（6 种 + 代码块增强）

> 协议定义 **6 种** JSON 卡片（`CARD_TYPES`）；F-08-07 为 Markdown 代码块 UI 增强，非第 7 种卡片类型。

| ID | 卡片类型 | 交互 |
|----|----------|------|
| F-08-01 | `paper_card` | 入库、引用、打开 PDF、查看文献库 |
| F-08-02 | `task_card` | 查看面板、标记完成 |
| F-08-03 | `progress_card` | 周期科研进度摘要 |
| F-08-04 | `approval_card` | HiL 批准/拒绝/始终批准 |
| F-08-05 | `file_card` | 打开、下载、Git 状态 |
| F-08-06 | `monitor_digest` | 监控扫描结果摘要 |
| F-08-07 | 代码块增强 | Copy / Save to workspace |

### 9. 文献库（Literature）

| ID | 功能 | 说明 |
|----|------|------|
| F-09-01 | 论文 CRUD | 【Agent】SQLite `rc_papers` + FTS5；面板列表/分页/loadMore |
| F-09-02 | 收件箱 / 归档 / 收藏 | 【面板】三视图 + 收藏集下拉加入/移除 |
| F-09-03 | 阅读状态 | 【面板】unread / reading / read / reviewed，可撤销 toast |
| F-09-04 | 标签管理 | 【面板】彩色标签筛选 + `PaperCard` 内编辑入口 |
| F-09-05 | 收藏集 Collections | 【面板】侧边选择器浏览收藏集 |
| F-09-06 | Smart Groups | 【后端】DB schema 已有；**无面板 UI** |
| F-09-07 | 阅读会话统计 | 【Agent】`library_reading_stats` |
| F-09-08 | 论文批注 Notes | 【Agent】`library_add_note` |
| F-09-09 | 引用图谱 | 【Agent】`library_citation_graph` |
| F-09-10 | BibTeX 导入/导出 | 【Agent】`library_import_bibtex` / `library_export_bibtex` |
| F-09-11 | RIS 导入 | 【Agent】`library_import_ris` |
| F-09-12 | 去重检测 | 【Agent】DOI / arXiv ID |
| F-09-13 | Zotero 只读导入 | 【Agent】`library_zotero` |
| F-09-14 | EndNote 集成 | 【Agent】`library_endnote` |
| F-09-15 | 面板搜索/筛选/排序 | 【面板】标题 FTS、标签多选、排序 |
| F-09-16 | 打开 PDF | 【面板】系统默认应用打开 `pdf_path` |
| F-09-17 | 复制引用 | 【面板】复制最小 BibTeX 条目到剪贴板 |
| F-09-18 | Agent 搜论文入库 | 【Agent】18+ 学术 API 联搜 |
| F-09-19 | PDF 拖入解析 | 【Agent/Chat】元数据提取 + 入库 |
| F-09-20 | 批量添加 | 【Agent】`library_batch_add` |
| F-09-21 | IntraView 精读 | 【面板】论文菜单 → 提问 Modal → 隐藏 IntrAgent 工作流 prompt 发往 Chat |

**Agent 工具：** `library_add_paper`, `library_search`, `library_list_papers`, `library_update_paper`, `library_get_paper`, `library_delete_paper`, `library_export_bibtex`, `library_reading_stats`, `library_batch_add`, `library_manage_collection`, `library_tag_paper`, `library_add_note`, `library_import_bibtex`, `library_citation_graph`, `library_zotero`, `library_endnote`, `library_import_ris`

### 10. 任务系统（Tasks）

| ID | 功能 | 说明 |
|----|------|------|
| F-10-01 | 截止日期排序列表 | 非 Kanban |
| F-10-02 | 分区显示 | 逾期 / 即将到期 / 已完成（折叠） |
| F-10-03 | 四级优先级 | urgent / high / medium / low |
| F-10-04 | 任务类型 | human / agent / mixed |
| F-10-05 | 状态流转 | todo / in_progress / blocked / done / cancelled |
| F-10-06 | 视角切换 | 全部 / 我的 / 助手 |
| F-10-07 | 子任务 | parent_task_id 一层嵌套 |
| F-10-08 | 关联论文 | related_paper_id |
| F-10-09 | 关联工作区文件 | related_file_path |
| F-10-10 | 任务备注 & 活动日志 | rc_activity_log 审计 |
| F-10-11 | 面板内勾选完成 | Direct RPC |
| F-10-12 | 任务详情展开 | 描述、标签、子任务、动态 |
| F-10-13 | 询问助手汇报进展 | 预填 prompt（human/agent/mixed） |
| F-10-14 | 甘特图视图 | 日/周/月，有 deadline 的任务 |
| F-10-15 | 搜索任务 | 面板内过滤 |
| F-10-16 | Chat 创建任务 | `/task` 或自然语言 → task_card |
| F-10-17 | 截止预警 & 通知 | 48h 默认阈值 |

**Agent 工具：** `task_create`, `task_list`, `task_complete`, `task_update`, `task_link`, `task_note`, `task_link_file`, `task_delete`, `task_flow_stage`, `cron_update_schedule`, `send_notification`

### 11. 工作区（Workspace + Git）

| ID | 功能 | 说明 |
|----|------|------|
| F-11-01 | 文件树 | sources/ outputs/ 等目录结构 |
| F-11-02 | 最近变更 | Top N 修改文件 + 相对时间 |
| F-11-03 | 上传文件 | HTTP POST `/rc/upload` + 面板上传 |
| F-11-04 | 拖拽上传 | Chat / 工作区面板 |
| F-11-05 | 新建文件/文件夹 | 上下文菜单 |
| F-11-06 | 重命名 / 移动 | `workspace_move` |
| F-11-07 | 删除（确认） | 带确认对话框 |
| F-11-08 | 打开文件/文件夹 | 系统默认；Docker 降级下载 |
| F-11-09 | 复制路径 | 剪贴板 |
| F-11-10 | 文件预览 | 文本/代码内联预览，大二进制拒绝 |
| F-11-11 | 文件搜索 | 树内过滤 |
| F-11-12 | Git 状态标记 | M / + 徽章 |
| F-11-13 | 版本历史 | `workspace_history` |
| F-11-14 | Diff 查看 | `workspace_diff` |
| F-11-15 | 版本恢复 | `workspace_restore` |
| F-11-16 | 自动 Git 提交 | 5s debounce，纯本地 |
| F-11-17 | 路径沙箱 | 拒绝 `../` 越界写入 |
| F-11-18 | 系统文件显示开关 | `.ResearchClaw/` 等 |
| F-11-19 | 导出工作区 | Agent `workspace_export` |
| F-11-20 | 下载 | GET `/rc/download` |

> 跨面板预览见 **F-06-20**（file_card / 任务详情 / 评审报告）。

**Agent 工具：** `workspace_save`, `workspace_read`, `workspace_list`, `workspace_diff`, `workspace_history`, `workspace_restore`, `workspace_move`, `workspace_export`, `workspace_delete`, `workspace_append`, `workspace_download`

### 12. 监控系统（Monitor，替代旧 Radar）

| ID | 功能 | 说明 |
|----|------|------|
| F-12-01 | 多监控实例 | DB 驱动，非硬编码 preset |
| F-12-02 | 源类型 | arXiv / GitHub / RSS / Webpage / OpenAlex / Twitter / Custom |
| F-12-03 | 启用/停用 Switch | 绑定 gateway cron job |
| F-12-04 | Cron 调度 | 可读 cron + 人类可读描述 |
| F-12-05 | 立即运行 | 手动 trigger |
| F-12-06 | 最近发现展示 | 展开卡片内列表 |
| F-12-07 | 删除监控 | 确认 + 清 job |
| F-12-08 | Chat 添加监控 | 「添加监控」预填 |
| F-12-09 | 询问助手扫描 | askAgent prompt |
| F-12-10 | monitor_digest 卡片 | Chat 内结构化推送 |
| F-12-11 | IM 推送 | 通道配置后推送到手机 |

**Agent 工具：** `monitor_create`, `monitor_list`, `monitor_report`, `monitor_get_context`, `monitor_note`

### 13. 定时任务预设（Cron Presets）

| ID | 预设 ID | 功能 |
|----|---------|------|
| F-13-01 | `arxiv_daily_scan` | 每日 arXiv 扫描 |
| F-13-02 | `citation_tracking_weekly` | 每周引用追踪 |
| F-13-03 | `deadline_reminders_daily` | 每日截止提醒 |
| F-13-04 | `group_meeting_prep` | 组会材料准备 |
| F-13-05 | `weekly_report` | 每周科研汇报 |
| F-13-06 | 激活/停用/删/恢复 | `rc.cron.presets.*` RPC |
| F-13-07 | Agent 改 schedule | `cron_update_schedule` 工具 |
| F-13-08 | 面板改 preset schedule | `rc.cron.presets.updateSchedule`（Monitor/Cron 面板） |

### 14. 心跳（Heartbeat）

| ID | 功能 | 说明 |
|----|------|------|
| F-14-01 | 周期性后台检查 | 截止、阅读提醒、监控摘要等 |
| F-14-02 | 可配置间隔 | 15m / 30m / 1h / 2h / 4h |
| F-14-03 | 静默时段 | 23:00–08:00（设计默认） |
| F-14-04 | StatusBar 显示 | 「HB: N 分钟前」 |
| F-14-05 | 抑制通知 | `rc.heartbeat.suppress` |
| F-14-06 | HEARTBEAT.md 驱动 | bootstrap 定义检查项 |
| F-14-07 | Cron 完成 Toast | `CronEventListener` 监听 gateway `cron` finished 事件 |

### 15. 通知系统

| ID | 功能 | 说明 |
|----|------|------|
| F-15-01 | 铃铛 + 未读角标 | TopBar |
| F-15-02 | 通知下拉列表 | 按优先级着色 |
| F-15-03 | 全部已读 | markAllRead |
| F-15-04 | 来源 | 任务逾期、监控发现、HiL、心跳、Agent 错误、版本更新 |
| F-15-05 | Agent 推送 | `send_notification` 工具 |
| F-15-06 | rc.notifications.* | pending + markRead RPC |
| F-15-07 | 点击跳转 | 关联 chat 消息；含 `targetSessionKey` 时切换会话 |
| F-15-08 | 通知音效 | 见 F-16-20（设置开关） |

### 16. 设置（Settings 面板）

| ID | 功能 | 说明 |
|----|------|------|
| F-16-01 | 模型供应商 & 主模型 | ProviderPickerModal |
| F-16-02 | 多 API 配置档案 | `ApiProfilesSection`：命名 `custom-{slug}` 槽位，加载/激活/删除，显示名存 `ui.researchClaw.customApiProfiles` |
| F-16-03 | OAuth 配置流 | 多 provider OAuth modal |
| F-16-04 | 独立视觉模型 | ON/OFF + 独立 provider |
| F-16-05 | 高级文本/管控端点 | baseUrl、API 协议折叠区 |
| F-16-06 | 代理 | ON/OFF + URL |
| F-16-07 | 网页搜索 | Brave / Gemini / Grok / Kimi / Perplexity |
| F-16-08 | 心跳间隔 | Segmented 选择 |
| F-16-09 | 智能质量管控 | 见 §17 |
| F-16-10 | 附加系统提示 | 编辑即 localStorage + 防抖写 config；**无需点保存**；`chat.send` 前 `rc.dashboard.setSystemPromptAppend`（读：`getSystemPromptAppend`） |
| F-16-11 | 显示系统文件 | workspace 树开关 |
| F-16-12 | 保存 & 网关重启 | Modal 确认 → `config.apply` + `serializeConfigForGatewayApply`；`ConfigRestartListener` 处理重连 |
| F-16-13 | About | 版本、OpenClaw 版本、插件、浏览器状态 |
| F-16-14 | 复制诊断信息 | 剪贴板 |
| F-16-15 | GitHub 链接 | 开源仓库 |
| F-16-16 | 检查更新 | `rc.app.check_updates` |
| F-16-17 | 一键更新 | `rc.app.apply_update` |
| F-16-18 | 重启科研龙虾 | About 区 restart → `config.get` + 无变更 `config.apply` |
| F-16-19 | 工具调用探测 | 加载 config 后自动 `rc.model.probeToolCalling` → Chat 工具警告 Banner（F-06-14） |
| F-16-20 | 通知音效 | 新通知 Web Audio 短提示音；`localStorage`，默认开启 |

### 17. 智能质量管控（Dual Model Supervisor）

| ID | 功能 | 说明 |
|----|------|------|
| F-17-01 | 双模型架构 | 主模型执行 + Reviewer 模型审查 |
| F-17-02 | 管控模式 | off / filter-only / correct；旧 full 配置迁移为 correct |
| F-17-03 | 输出审查 | 伪造引用、敏感信息、危险命令 |
| F-17-04 | 工具调用审查 | exec/write/edit/send_notification/browser 等 |
| F-17-05 | 方向纠正 | deviationThreshold 可配 |
| F-17-06 | 研究约束连续性 | 每轮提示保留研究目标、目标结论和方法约束；不承诺压缩前保护或内容级丢失检测 |
| F-17-07 | 后续轮次纠偏 | 当前回答已交付；检测到偏离后仅向下一轮注入纠偏建议，最大尝试次数可配 |
| F-17-08 | 异步审查结果交付 | DB 可用时持久化审计，并由 Dashboard 面板/RPC 查询；写入失败可观察 |
| F-17-09 | 管控日志面板 | 展示持久化审计与统计；未知历史类型使用通用回退显示 |
| F-17-10 | 研究目标解析 | goal + target conclusions 展示 |
| F-17-11 | rc.supervisor.* RPC | config / status / audit |

### 18. 扩展面板（Extensions）

| ID | 子 Tab | 功能 |
|----|--------|------|
| F-18-01 | 技能 Skills | 500+ 技能虚拟列表、分组、启停、依赖检查 |
| F-18-02 | 技能工坊 Workshop | `SkillWorkshopTab`：提案 list/inspect/create/revise/apply/reject/quarantine |
| F-18-03 | 通道 Channels | Telegram / 微信 / QQ / 飞书 / Slack 等 |
| F-18-04 | 通道 QR 登录 | 微信 / WhatsApp 扫码 |
| F-18-05 | 插件 Plugins | openclaw.json entries 启停 |
| F-18-06 | PPT | ppt-master 集成：init / export / 源文件选择 |
| F-18-07 | skill_search 工具 | Chat 发现技能内容 |
| F-18-08 | skill_workshop 工具 | 治理式技能创建（非 raw write SKILL.md） |
| F-18-09 | Workshop 筛选 | today / pending / applied 视图 |
| F-18-10 | Workshop → Chat | 「继续到 Chat」预填提案上下文 |
| F-18-11 | Workshop 配置 | `skills.workshop`：`autonomous.enabled` false、`approvalPolicy: pending`、`maxPending: 50`、`maxSkillBytes: 40000`；`extraDirs` 含 `./workspace/skills` |

**Gateway RPC（Workshop）：** `skills.proposals.list`, `inspect`, `create`, `update`, `revise`, `apply`, `reject`, `quarantine`

**技能生态：** 438 内置学术技能（@wentorai/research-plugins），分类：文献检索 87 · 研究方法 79 · 数据分析 68 · 写作 74 · 学科 93 · 工具 51 · 集成 35

### 19. IM 通道与远程控制

| ID | 功能 | 说明 |
|----|------|------|
| F-19-01 | 微信 | openclaw-weixin 插件，扫码登录，多账号 |
| F-19-02 | Telegram | 通道配置 + 推送 |
| F-19-03 | 飞书 / QQ / 钉钉 / Slack | 通道扩展 |
| F-19-04 | 手机派活 | IM 发消息 → 本机执行 |
| F-19-05 | 多账号上下文隔离 | per-channel-per-peer 模式 |
| F-19-06 | wentor-connect | 占位/未来扩展插件 |

### 20. Agent 科研场景能力

| ID | 场景 | 能力 |
|----|------|------|
| F-20-01 | 搜论文 | 18+ 学术库联搜，结构化返回 |
| F-20-02 | 管文献 | 入库、标签、阅读状态、Zotero 分类摘要 |
| F-20-03 | 写论文 | Related Work / 各章节初稿 + BibTeX 同步 |
| F-20-04 | 管任务 | 创建、优先级、截止、提醒 |
| F-20-05 | 追热点 | Monitor + IM 推送 |
| F-20-06 | 读 PDF | 元数据 + 笔记 |
| F-20-07 | 跑 Stata/R/Python | 生成脚本 → HiL 确认 → exec |
| F-20-08 | 组会材料 | 定时 cron + 进展汇总 |
| F-20-09 | 邮件起草 | IMAP/SMTP skill，确认后发送 |
| F-20-10 | GPU 实验复现 | clone/env/run/排障/紧急汇报 |
| F-20-11 | PPT 生成 | ppt_init / ppt_export |
| F-20-12 | 论文评审 | 工作区 PDF + 14 类 Rubric → 结构化审稿报告（见 §23） |
| F-20-13 | 学术数据库工具 | arXiv · OpenAlex · CrossRef · PubMed 等 34 tools |
| F-20-14 | MCP 即插即用 | Zotero · GitHub · Jupyter 等 150 配置 |

### 21. Bootstrap 与 Prompt 体系

| ID | 文件 | 功能 |
|----|------|------|
| F-21-01 | SOUL.md | 科研人格、6 原则、7 红线 |
| F-21-02 | AGENTS.md | 工作流、卡片协议、HiL、Quick Paths |
| F-21-03 | HEARTBEAT.md | 周期检查定义 |
| F-21-04 | BOOTSTRAP.md | 首次运行引导（完成后自删） |
| F-21-05 | IDENTITY.md | 产品身份 |
| F-21-06 | USER.md | 用户画像模板 |
| F-21-07 | TOOLS.md | 环境/API 备忘录（L3 用户文件） |
| F-21-08 | MEMORY.md | Agent 持久笔记模板（Markdown 文件，非 Dashboard 记忆面板） |

### 22. 安全模型

| ID | 层级 | 机制 |
|----|------|------|
| F-22-01 | L1 网络 | loopback only |
| F-22-02 | L2 沙箱 | workspace 路径校验 |
| F-22-03 | L3 Exec Guard | 拦截 rm -rf /、dd、fork bomb 等 |
| F-22-04 | L4 Git | 全历史可恢复 |
| F-22-05 | L+ HiL | approval_card + AGENTS.md 协议 |
| F-22-06 | 本地数据 | 无 telemetry，API Key 本地存储 |

### 23. 论文评审（Paper Review）

| ID | 功能 | 说明 |
|----|------|------|
| F-23-01 | 左导航「评审」Tab | `PaperReviewPanel`，默认启用 |
| F-23-02 | 工作区 PDF/文稿候选 | `rc.review.candidates` 扫描 `sources/` 等可评审扩展名 |
| F-23-03 | 14 类学科 Rubric | cs-ml / cs-vision / cs-nlp / … / economics / general 等顶会标准 |
| F-23-04 | 发起 Agent 评审 | `rc.review.create` → cron 一次性 run → 轮询状态 |
| F-23-05 | 评审报告展示 | Markdown 报告、评分、优劣势、建议；`MarkdownBody` 渲染 |
| F-23-06 | 历史记录管理 | list/get/update/delete；复制、打开源文件/报告、删除 |
| F-23-07 | 完成通知 | 评审完成时系统通知 |
| F-23-08 | 跨面板打开 | 报告/源文件 → 工作区预览（F-06-20） |
| F-23-09 | 取消评审 | `cancelReview` → 状态 failed，停止轮询 |
| F-23-10 | 失败监听 | `PaperReviewRunListener` 捕获 agent/chat 错误 → 失败通知 |
| F-23-11 | Brief 结构化摘要 | `buildPaperReviewBrief`：verdict、证据充分性、置信度标签 |
| F-23-12 | 面板状态持久化 | 选中文件/评审/学科存 `localStorage`；重连 `restoreSession` |

**RPC：** `rc.review.candidates`, `rc.review.list`, `rc.review.get`, `rc.review.create`, `rc.review.update`, `rc.review.delete`

> **注：** `paper-review-stages.ts` 三阶段编排代码存在，当前 UI 使用单次 cron run，未接入分阶段进度条。

### 24. 浏览器自动化（默认配置）

| ID | 功能 | 说明 |
|----|------|------|
| F-24-01 | 默认启用 browser | `config-patch` / `openclaw.example.json`：`browser.enabled: true` |
| F-24-02 | Research-Claw CDP Profile | `defaultProfile: research-claw`，CDP 端口 18800 |
| F-24-03 | browser-automation 技能 | `config/plugin-skills/browser-automation/SKILL.md` 指导多步 browser 流程 |
| F-24-04 | About 状态显示 | Settings About 区显示浏览器启停 |

---

## 二、测试用例

### 模块 A：安装与首次启动

| 用例 ID | 优先级 | 前置条件 | 步骤 | 预期结果 |
|---------|--------|----------|------|----------|
| TC-A-01 | P0 | 干净 macOS，Node≥22 | 执行 install.sh | 安装成功，gateway 可启动，Dashboard 可访问 |
| TC-A-02 | P0 | Docker 环境 | docker compose up | 容器健康，28789 可访问 |
| TC-A-03 | P0 | 首次启动无 config | 打开 Dashboard | 显示 Setup Wizard |
| TC-A-04 | P0 | 有效 API Key | 选 provider → 填 key → 启动 | 进入三栏 Dashboard，Agent 可回复 |
| TC-A-05 | P1 | 无效 API Key | Setup 保存 | 显示连接/格式错误，不进入主界面 |
| TC-A-06 | P1 | Ollama 运行中 | 选本地 provider | 自动列出已安装模型 |
| TC-A-07 | P1 | 需代理网络 | Setup 填代理 URL | 保存后 gateway 重启，API 调用成功 |
| TC-A-08 | P2 | 已配置用户 | 点「跳过向导」 | 进入 Dashboard（可能 API 未配） |

### 模块 B：网关与 Dashboard 壳层

| 用例 ID | 优先级 | 步骤 | 预期结果 |
|---------|--------|------|----------|
| TC-B-01 | P0 | 停止 gateway 再打开 Dashboard | 显示 disconnected banner，自动重连 |
| TC-B-02 | P0 | 切换暗色/浅色主题 | 全局 token 切换，刷新后保持 |
| TC-B-03 | P1 | 切换 EN ↔ 中文 | 导航/面板文案切换 |
| TC-B-04 | P1 | 拖拽配置面板边缘 | 宽度/高度改变，双击复位 |
| TC-B-05 | P1 | 切换 dock 到左/上/下（含 DockPicker 图标） | 面板位置正确，内容可滚动 |
| TC-B-06 | P2 | 窗口缩至 <1024px | 配置面板变 overlay / sheet |
| TC-B-07 | P1 | StatusBar 发一条长对话 | Token In/Out 递增（`sessions.usage` + sessionKey） |
| TC-B-08 | P1 | 展开 cron 会话组 → 删除会话 | 确认后 session 与 cron job 均清除 |
| TC-B-09 | P2 | 折叠左导航 → 刷新页面 | 折叠状态保持 |

### 模块 C：会话与 Chat

| 用例 ID | 优先级 | 步骤 | 预期结果 |
|---------|--------|------|----------|
| TC-C-01 | P0 | 发送「你好」 | 流式回复，Agent 状态 idle→streaming→idle |
| TC-C-02 | P0 | `/new` | 新 session，历史清空 |
| TC-C-03 | P0 | 长任务运行中点 Stop | run 中止，输入内容恢复 |
| TC-C-04 | P1 | 对含唯一目标、数值单位条件、方法参数、精确引用、负结果、未决问题和证据等级的 fixture 执行 `/compact` | 请求收到 RC 科研指令；摘要逐项保留 fixture 语义，不外推为普遍无损保证 |
| TC-C-05 | P1 | `/model` 无参 | 显示当前模型 |
| TC-C-06 | P1 | 上传 <5MB PNG | 附件预览，发送成功 |
| TC-C-07 | P1 | 上传 >5MB 图片 | 拒绝并提示 |
| TC-C-08 | P1 | 无 vision 模型发图 | 提示启用视觉模型 |
| TC-C-09 | P1 | ↑ 键 | 上一条历史输入 |
| TC-C-10 | P2 | 闲置超 policy 后发消息 | stale session 确认框 |
| TC-C-11 | P1 | 新建第 2 会话并行发消息 | 两 session 互不阻塞 |
| TC-C-12 | P1 | 会话 daily/idle 过期后发消息 | Banner 可见 + 发送前 Modal.confirm |
| TC-C-13 | P1 | 流式生成中按 Esc / Ctrl+C | run 中止，draft 恢复 |
| TC-C-14 | P1 | 多工具对话运行中 | TaskFlowTimeline 显示 understand/execute/respond |
| TC-C-15 | P2 | Agent 调用 `task_flow_stage` | 时间线显示显式阶段标签 |

### 模块 D：结构化卡片

| 用例 ID | 优先级 | 步骤 | 预期结果 |
|---------|--------|------|----------|
| TC-D-01 | P0 | Agent 返回 paper_card → 添加入库 | 文献库出现该论文 |
| TC-D-02 | P0 | task_card → 标记完成 | 任务面板状态 done |
| TC-D-03 | P0 | approval_card → 拒绝 | Agent 不执行该操作 |
| TC-D-04 | P1 | file_card → 打开 | 系统打开或 Docker 下载 |
| TC-D-05 | P1 | monitor_digest → 查看详情 | 展开 findings 列表 |
| TC-D-06 | P1 | progress_card | 指标数字与 highlights 渲染正确 |
| TC-D-07 | P2 | 未知 fenced type | 降级为普通代码块 |

### 模块 E：文献库

| 用例 ID | 优先级 | 步骤 | 预期结果 |
|---------|--------|------|----------|
| TC-E-01 | P0 | Chat：「搜 Multi-Agent Debate 最新论文」 | 返回结果，可入库 |
| TC-E-02 | P0 | Chat：「把这 5 篇入库，标签 LLM」 | 5 篇出现在文献库 |
| TC-E-03 | P0 | 面板切换阅读状态 unread→read | RPC 成功，徽章变色 |
| TC-E-04 | P1 | 搜索框输入关键词 | FTS 过滤列表 |
| TC-E-05 | P1 | 编辑标签 | 保存后卡片/列表同步 |
| TC-E-06 | P1 | 导出 BibTeX | 文件内容正确 |
| TC-E-07 | P1 | 本地有 Zotero → 「导入 Zotero」 | 论文批量导入 |
| TC-E-08 | P1 | 拖入 PDF 到 Chat | 元数据提取 + 入库 |
| TC-E-09 | P2 | 重复 DOI 添加 | 去重提示或合并 |
| TC-E-10 | P1 | 打开 PDF | 系统 PDF 阅读器打开 |
| TC-E-11 | P1 | 文献库 → IntraView → 输入问题 | Chat 仅显示用户问题；Agent 收到精读工作流 prompt |

### 模块 F：任务

| 用例 ID | 优先级 | 步骤 | 预期结果 |
|---------|--------|------|----------|
| TC-F-01 | P0 | 「创建任务：周五前交审稿，高优先级」 | task_card + 面板 upcoming |
| TC-F-02 | P0 | 面板勾选完成 | 移入 completed 区 |
| TC-F-03 | P1 | 创建逾期任务 | 出现在 overdue，红色标注 |
| TC-F-04 | P1 | 切换「助手任务」视角 | 仅 agent/mixed |
| TC-F-05 | P1 | 展开任务详情 → 询问助手 | 预填对应 prompt |
| TC-F-06 | P2 | 打开甘特图 | 有 deadline 任务按时间轴展示 |
| TC-F-07 | P1 | 关联论文的任务 | 详情显示论文标题 |

### 模块 G：工作区

| 用例 ID | 优先级 | 步骤 | 预期结果 |
|---------|--------|------|----------|
| TC-G-01 | P0 | Agent 写入 `outputs/draft.md` | 文件树可见，Git M 标记 |
| TC-G-02 | P0 | 面板上传 CSV | 上传成功 toast |
| TC-G-03 | P1 | 查看版本历史 → restore | 内容回滚 |
| TC-G-04 | P1 | 重命名文件 | move RPC 成功 |
| TC-G-05 | P1 | 删除文件确认 | 文件消失，Git 记录 |
| TC-G-06 | P2 | 预览大文件 (>限制) | 提示过大 |
| TC-G-07 | P1 | Docker 环境打开文件 | 显示下载降级 UI |
| TC-G-08 | P1 | file_card「打开」 | 切到工作区 Tab 并预览对应路径 |

### 模块 H：监控与定时

| 用例 ID | 优先级 | 步骤 | 预期结果 |
|---------|--------|------|----------|
| TC-H-01 | P0 | Chat：「每天盯 arXiv cs.CL 新论文」 | 创建 monitor，cron 绑定 |
| TC-H-02 | P0 | 面板启用 monitor → 立即运行 | runTriggered，后续有 findings |
| TC-H-03 | P1 | 停用 monitor | cron job 清除 |
| TC-H-04 | P1 | 删除 monitor | DB + UI 同步移除 |
| TC-H-05 | P1 | 激活 `weekly_report` preset | rc_cron_state enabled=1 |
| TC-H-06 | P1 | 修改 preset schedule | 新 cron 表达式生效 |
| TC-H-07 | P1 | 心跳间隔改 15m | StatusBar HB 更新频率变化 |
| TC-H-08 | P2 | monitor_digest 在 Chat 出现 | 卡片字段完整 |
| TC-H-09 | P2 | Cron/监控 run 完成 | `CronEventListener` 主题 Toast |

### 模块 I：通知

| 用例 ID | 优先级 | 步骤 | 预期结果 |
|---------|--------|------|----------|
| TC-I-01 | P1 | 任务 24h 内到期 | 铃铛角标 + 高优先级项 |
| TC-I-02 | P1 | Agent send_notification | 通知列表新增 |
| TC-I-03 | P1 | Mark all read | 角标清零 |
| TC-I-04 | P2 | 点击带 targetSessionKey 的通知 | 切换到对应会话 |

### 模块 J：设置与更新

| 用例 ID | 优先级 | 步骤 | 预期结果 |
|---------|--------|------|----------|
| TC-J-01 | P0 | 切换主模型并保存 | gateway 重启，新模型生效 |
| TC-J-02 | P1 | 添加第二套 API 档案并切换 | 无需重填 key |
| TC-J-03 | P1 | OAuth provider 完整流程 | token 保存，模型可用 |
| TC-J-04 | P1 | 启用网页搜索 + 填 Brave key | Agent 可 web search |
| TC-J-05 | P1 | 检查更新 | 显示 current/latest |
| TC-J-06 | P2 | 一键更新（测试环境） | apply_update 返回成功 |
| TC-J-07 | P1 | 复制诊断信息 | 剪贴板含版本/gateway 信息 |
| TC-J-08 | P1 | systemPromptAppend 修改（不点保存） | 下条 `chat.send` 前 `rc.dashboard.setSystemPromptAppend` 已同步 |
| TC-J-09 | P2 | 关闭通知音效 | 新通知无提示音 |
| TC-J-10 | P0 | 保存主模型 | Modal 确认 → `config.apply` → gateway 重启 → Dashboard 重连刷新 config |
| TC-J-11 | P1 | About → 重启科研龙虾 | 无配置变更的 `config.apply` 成功 |
| TC-J-12 | P1 | 不支持 tools 的模型 | 自动 probe 后 Chat 显示工具调用警告 Banner |

### 模块 K：质量管控

| 用例 ID | 优先级 | 步骤 | 预期结果 |
|---------|--------|------|----------|
| TC-K-01 | P1 | 启用 supervisor + correct 模式 | 管控面板 status=on |
| TC-K-02 | P1 | 触发 exec 高风险命令 | tool_review log，可能 block |
| TC-K-03 | P1 | 主模型偏离研究目标 | 当前回答不被替换；下一轮收到 course_correction 注入，达到上限后不再重复 |
| TC-K-04 | P2 | correct 模式下继续多轮研究对话 | 后续提示仍含研究目标、目标结论和方法约束；不产生专用压缩保护审计 |
| TC-K-05 | P1 | 面板筛选 action=block | 仅显示拦截记录 |

### 模块 L：扩展与 IM

| 用例 ID | 优先级 | 步骤 | 预期结果 |
|---------|--------|------|----------|
| TC-L-01 | P1 | Extensions → 禁用某 skill | eligible=false，Agent 不可用 |
| TC-L-02 | P1 | Workshop 新建提案 → apply | workspace/skills 出现新 SKILL.md |
| TC-L-03 | P1 | 微信 QR 登录 | connected 状态 |
| TC-L-04 | P0 | 手机微信发「这周有什么新论文」 | 本机 Agent 回复 + 可入库 |
| TC-L-05 | P2 | PPT tab 提交生成任务 | ppt_init 成功，outputs 有 pptx |
| TC-L-06 | P1 | Channels 停用 Telegram | 不再收发 |
| TC-L-07 | P2 | Workshop reject / quarantine | 提案状态更新，未写入 skills 目录 |
| TC-L-08 | P2 | Workshop「继续到 Chat」 | 输入框预填提案上下文 |
| TC-L-09 | P2 | Workshop today/pending/applied 筛选 | 列表按状态过滤正确 |

### 模块 N：安全

| 用例 ID | 优先级 | 步骤 | 预期结果 |
|---------|--------|------|----------|
| TC-N-01 | P0 | Agent 尝试 `rm -rf /` | Exec Guard 拦截 |
| TC-N-02 | P1 | workspace_save 写 `../etc/passwd` | 路径校验拒绝 |
| TC-N-03 | P1 | 批量删文献无确认 | approval_card 出现 |
| TC-N-04 | P2 | 外网访问 28789 | 连接失败（非 loopback） |

### 模块 O：端到端科研场景

| 用例 ID | 优先级 | 场景 | 预期结果 |
|---------|--------|------|----------|
| TC-O-01 | P0 | Zotero 200 篇分类+摘要 | Collection + 摘要写回 |
| TC-O-02 | P1 | 写 Related Work 2800 词 | 文件落盘 + references.bib 同步 |
| TC-O-03 | P1 | 周五 8 点组会材料 | cron 触发 + IM/Dashboard 通知 |
| TC-O-04 | P1 | Stata DID do file | 生成 → HiL → 执行 → 结果返回 |
| TC-O-05 | P2 | arxiv 论文 GPU 复现 | clone/env/run，阻塞时紧急汇报 |
| TC-O-06 | P1 | 起草邮件 → 确认发送 | 不擅自发送 |

### 模块 P：论文评审

| 用例 ID | 优先级 | 步骤 | 预期结果 |
|---------|--------|------|----------|
| TC-P-01 | P1 | 评审 Tab → 选 workspace PDF → cs-ml → 运行 | 状态 in_progress → completed，报告 Markdown 可见 |
| TC-P-02 | P1 | 完成评审 | 系统通知 + 历史列表新增记录 |
| TC-P-03 | P2 | 打开报告 / 源文件 | 跳转工作区预览 |
| TC-P-04 | P2 | 复制报告、删除历史 | 剪贴板正确；DB 记录移除 |
| TC-P-05 | P1 | 评审运行中点取消 | 状态 failed，轮询停止 |
| TC-P-06 | P2 | 评审 cron 失败 | 失败通知 + 记录 status failed |
| TC-P-07 | P2 | 选 PDF + 学科 → 刷新 Dashboard | localStorage 恢复选中项 |

### 模块 M：浏览器自动化（§24）

| 用例 ID | 优先级 | 步骤 | 预期结果 |
|---------|--------|------|----------|
| TC-M-01 | P2 | 查看 `openclaw.json` browser 段 | `enabled: true`，profile `research-claw` |
| TC-M-02 | P2 | Settings About | 浏览器状态显示 enabled/disabled |
| TC-M-03 | P2 | 确认 `browser-automation` 技能存在 | skills 目录可加载 |
| TC-M-04 | P2 | CDP 端口 | 配置为 18800（默认 profile） |

### 模块 Q：外设子系统（Peripherals，§2.7）

> 手动验收用例；依赖 Dashboard 打开 + 摄像头物理可用（TC-Q-02/Q-03 需真实浏览器环境）。  
> 所有 TC-Q-* 均待 T19 真机验收，当前处于静态代码审查阶段。

#### Q-1：面板可达 & 基础 UI

| 用例 ID | 优先级 | 步骤 | 预期结果 |
|---------|--------|------|----------|
| TC-Q-01 | P1 | 打开 Dashboard → 左导航点击「外设」 | PeripheralsPanel 加载，显示摄像头/Plaud/定时查证/置灰双卡四区块 |
| TC-Q-02 | P1 | 外设面板 → 点击「启用摄像头桥」开关 | 浏览器请求摄像头权限，桥在线状态变绿，顶栏出现摄像头图标 |
| TC-Q-03 | P2 | 禁用摄像头桥 | 状态变灰，`rc.periph.bridge.announce` 停止上报 |
| TC-Q-04 | P2 | Plaud 卡显示「未配置」 | Plaud 状态区显示 `tokenPresent: false` 提示，连接按钮可点 |
| TC-Q-05 | P2 | 置灰双卡（实体卡/嵌入式）渲染 | 卡片显示「即将推出」或对应占位文案，不可点击 |

#### Q-2：摄像头预览 & 拍照注入

| 用例 ID | 优先级 | 前置条件 | 步骤 | 预期结果 |
|---------|--------|----------|------|----------|
| TC-Q-06 | P1 | 桥已在线，已注册摄像头设备 | Chat：`periph_camera_snap` | 1–5s 内返回 frame_path；观测时间线新增 snapshot 记录 |
| TC-Q-07 | P1 | 同上 | Chat：`periph_camera_snap { device_id: "..." }` | 指定设备抓帧成功 |
| TC-Q-08 | P2 | 无启用摄像头设备 | Chat：`periph_camera_snap` | 返回 `no-enabled-camera` 结构化错误 |
| TC-Q-09 | P2 | 同上，有 2 个启用摄像头 | Chat：`periph_camera_snap`（不带 device_id） | 返回 `multiple-cameras` 错误，列出可用 ID |
| TC-Q-10 | P1 | 抓帧成功 | 查看工作区 `.ResearchClaw/periph/` | JPEG 文件落盘，路径与 frame_path 一致 |
| TC-Q-11 | P2 | Dashboard 未打开 | Chat：`periph_camera_snap` | 返回 `bridge-offline` 或 `bridge-timeout`，观测 verdict=missed |

#### Q-3：Plaud 状态与连接

| 用例 ID | 优先级 | 步骤 | 预期结果 |
|---------|--------|------|----------|
| TC-Q-12 | P1 | `mcp.servers.plaud` 未配置 | 面板 Plaud 区 → 刷新状态 | `configured: false`，显示配置引导 |
| TC-Q-13 | P1 | MCP 路径已配置但 token 缺失 | 面板 → 刷新状态 | `configured: true, tokenPresent: false` |
| TC-Q-14 | P2 | 完整配置 + 有效 token | 面板 → 登录 | `tokenPresent: true, toolsReady: true`，按钮变为「已连接」 |
| TC-Q-15 | P2 | Plaud MCP 服务未启动 | 面板 → 刷新状态 | `lastError` 含 spawn/connect 错误，不崩溃 |

#### Q-4：定时查证创建 / 启停 / 立即运行

| 用例 ID | 优先级 | 步骤 | 预期结果 |
|---------|--------|------|----------|
| TC-Q-16 | P1 | Chat：`monitor_create { source_type: 'device', name: '实验室摄像头-每小时', ... }` | monitor 创建成功，`source_type='device'` |
| TC-Q-17 | P1 | 外设面板定时查证区 → 启用该 monitor | cron job 绑定，状态 enabled=true |
| TC-Q-18 | P1 | 点「立即运行」 | `rc.monitor.run` 触发，Agent 收到扫描请求，执行 `periph_camera_snap` 并 `monitor_report` |
| TC-Q-19 | P2 | 停用 monitor | cron job 清除，enabled=false |
| TC-Q-20 | P2 | 删除 monitor | DB + 面板同步移除，cron 清除 |

#### Q-5：观测时间线

| 用例 ID | 优先级 | 步骤 | 预期结果 |
|---------|--------|------|----------|
| TC-Q-21 | P1 | 完成一次 `periph_camera_snap` 后打开外设面板 | 时间线显示 snapshot 记录（verdict/summary/captured_at） |
| TC-Q-22 | P1 | Chat：`periph_observe { kind: 'check', verdict: 'ok', summary: '设备正常' }` | 时间线新增 check 记录 |
| TC-Q-23 | P2 | `periph_list` | 返回设备列表，含 `latest_observation` 字段 |
| TC-Q-24 | P2 | `rc.periph.observations.list { limit: 5 }` via Dashboard | 面板观测时间线分页正确 |

#### Q-6：降级矩阵

| 用例 ID | 优先级 | 降级场景 | 预期行为 |
|---------|--------|----------|----------|
| TC-Q-25 | P1 | **Dashboard 关闭**（桥离线）→ `periph_camera_snap` | 返回 `bridge-offline`；观测 verdict=missed；不崩溃；网关稳定 |
| TC-Q-26 | P1 | **Docker 部署**（摄像头权限受限）→ 启用桥 | 浏览器提示权限拒绝；失败错误可读；无 crash |
| TC-Q-27 | P2 | **无权限** `getUserMedia` 拒绝 → `periph_camera_snap` | 返回 capture-failed 结构化错误，verdict=error |
| TC-Q-28 | P2 | **Plaud MCP 插件过旧 / 不兼容** → `plaud.status` | 返回 `lastError` 含版本或协议错误，不崩溃 |
| TC-Q-29 | P2 | **LAN HTTP 模式**（非 HTTPS，secureContext=false）→ 摄像头桥 announce | `secureContext: false` 记录到桥状态；面板显示 HTTPS 提示 |

---

## 三、测试组织建议

### 冒烟测试（约 30 分钟）

TC-A-01, TC-A-03, TC-A-04, TC-B-01, TC-C-01, TC-C-02, TC-C-14, TC-E-01, TC-E-02, TC-E-11, TC-F-01, TC-G-01, TC-H-01, TC-P-01, TC-L-04

### 回归顺序（按 LeftNav）

文献库 → 工作区 → 评审 → 任务 → 监控 → 质量管控 → 扩展 → 设置

### 环境矩阵

| 维度 | 选项 |
|------|------|
| 部署 | macOS 原生 · Docker · WSL2 |
| 网络 | 直连 · 代理 |
| UI | 中文 · English |

### 数据准备

- 空库（新安装）
- 含本地 Zotero
- 含 50+ 论文、逾期任务
- 已配微信/Telegram 通道

### 已有自动化

- Dashboard：**1880** unit tests（`dashboard/src/__tests__/`，含 task-flow / intraview / paper-review / api-profiles / session-freshness / periph-store / periph-camera / periph-capture 等）
- 插件：`extensions/research-claw-core`（963 tests，含 periph-bridge / periph-rpc / periph-service / periph-tools / fresh-install-peripherals 等）
- 质量管控：`extensions/dual-model-supervisor`（多测试）

**尚无组件级自动化：** `PaperReviewPanel.tsx`、`TaskFlowTimeline.tsx`（依赖手动 TC-P / TC-C-14）；`PeripheralsPanel.tsx` 真机行为依赖手动 TC-Q-*

#### 真网关端到端校验（`pnpm verify:e2e`）

单元测试证明不了「跨插件边界之后行为仍成立」，因此以下脚本各自拉起真实网关（端口 28799）与桩 provider（端口 28801），断言可观测终态。三者共用端口，必须串行；CI 在 `pnpm test` 之后执行同一条命令。

| 脚本 | 断言 |
|------|------|
| `verify-rpc-error-classification.mjs` | 领域错误/带 code 错误走 warn 单行，未预期错误走 error + stack；错误文本中的密钥不外泄 |
| `verify-runtime-self-check.mjs` | 启动自检与运行时挂载对账真实触发；缺失工具/被截断技能被识别；探针失败不阻塞运行 |
| `verify-cron-deadline-fallback.mjs` | 定时任务主 provider 超时后真正切换到 fallback，用户主动取消不触发 fallback |

`verify-docker-config.mjs` 需要 Docker 与已发布镜像，未纳入 CI；本地按需 `pnpm verify:docker`。

#### 超时预算层级（新增用例必须遵守）

CI runner 的核数远少于开发机，这些用例又都要冷启动子进程（diag.sh 每个产物起一个 node 脱敏进程；e2e 每次调用冷启动一次 OpenClaw CLI）。预算写反或写死太小，机器变慢就会被报成功能回归。

- **外层测试上限 > 内层子进程上限**。反过来会在子进程还没用完自己的预算时先杀掉测试，表现为 `SIGTERM`（exit 143）之类的假失败。`test/diag-security.test.ts` 用 `DIAG_TEST_TIMEOUT_MS` / `DIAG_SUBPROCESS_TIMEOUT_MS` 两个常量把这层关系写死。
- **轮询 deadline 必须由单次调用预算推导，不许写字面量**。两个数字只有相对关系才有意义：deadline ≤ 单次预算时，一次卡住的调用就吃光整个 deadline，看起来有重试其实一次都没重试过。两个 e2e 脚本统一用 `GATEWAY_CALL_TIMEOUT_MS` 与由它推导的 `POLL_DEADLINE_MS`。
- **轮询循环必须容忍单次调用失败**，只允许总 deadline 判失败，并把最后一次错误带进报错信息；否则一次慢冷启动就会终止整轮验收。
- **等待条件用相对量，不用绝对量**。`verify-cron-deadline-fallback.mjs` 曾用绝对请求数等待，而该阈值已被前一阶段满足，等待直接返回、导致后续断言打在尚未注册的 run 上。
- **各场景的超时要相互隔离**。同一脚本内定时任务用短 deadline 触发 fallback，交互式 run 必须另配长 deadline，否则「用户取消不触发 fallback」这一断言会变成与 deadline 抢跑。
- **临时目录只断言自己的文件前缀**，不要断言整个 `TMPDIR` 为空。Node 会把 `node-compile-cache` 等运行时产物写进同一目录，断言"空"实际在测运行时行为；CI 未设置 `NODE_DISABLE_COMPILE_CACHE`，这类断言必然失败。

三套 vitest 配置统一 `testTimeout: 30_000`（root / dashboard / research-claw-core）。

---

## 四、已知缺口与说明

| 项 | 状态 |
|----|------|
| 飞书文件夹子文档 | 未能批量抓取；主指南已合并 |
| README「21 种卡片」 | **营销口径**；协议与代码仅 **6 种**结构化卡片 + Markdown/代码块增强 |
| Radar 旧名 | 已统一为 **监控 Monitor** |
| Smart Groups / 文献批注 / 引用图谱 | 后端或 Agent 工具已有；**文献库面板无对应 UI** |
| 论文评审分阶段编排 | `paper-review-stages.ts` 存在，**当前 UI 未接入** |
| 知识图谱插件 | 仅设计文档，无实现 |
| `nav.memory` i18n | 翻译键存在，**无 LeftNav 入口**（RC 记忆模块默认未启用，不纳入本清单） |
| Dashboard parity 测试漂移 | 已修复(详见 git 历史) |

---

*功能以当前代码实现为准（版本号见根 `package.json`）· OpenClaw 2026.6.1 · DB SCHEMA_VERSION 16 · 不含 RC 记忆模块清单 · 外设 TC-Q-* 待 T19 真机复核*
