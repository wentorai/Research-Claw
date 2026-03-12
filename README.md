<div align="center">

<img src="assets/logo.png" width="200" alt="科研龙虾 · Research-Claw" />

# 科研龙虾 · Research-Claw

**本地 AI 科研助手 — 数据不离机，算力不上云**

[![Version](https://img.shields.io/badge/version-v0.1.0-EF4444?style=flat-square&logo=github)](https://github.com/wentorai/Research-Claw/releases)
[![License](https://img.shields.io/badge/license-BSL_1.1-3B82F6?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/Node.js-%3E%3D22-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS_%7C_Linux-lightgrey?style=flat-square)](#)
[![Skills](https://img.shields.io/badge/skills-487-EF4444?style=flat-square)](https://www.npmjs.com/package/@wentorai/research-plugins)

[🌐 wentor.ai](https://wentor.ai) · [🇬🇧 English](README.en.md) · [📖 文档](docs/00-reference-map.md) · [🪲 问题反馈](https://github.com/wentorai/Research-Claw/issues)

</div>

---

```bash
curl -fsSL https://wentor.ai/install.sh | bash
```

> **同一条命令，三种场景：首次安装 · 版本更新 · 重新启动**
> 首次运行：克隆仓库 → 安装依赖 → 构建 → 注册技能 → 打开浏览器
> 再次运行：`git pull` → 重新构建 → 重启（自动踢掉旧进程）
>
> Windows 用户 → [手动安装指南](docs/WINDOWS_INSTALL.md)（推荐 WSL2）

---

## 这是什么

科研龙虾是一个完全运行在你本机的 AI 学术研究助手。它整合了全球主流学术数据库的检索、文献管理、任务追踪和写作辅助，通过自然语言对话驱动整个科研工作流。

**你的论文库、笔记、研究数据，全部保存在你自己的机器上。不需要账号，不需要联网，不需要信任任何云服务。**

---

## 核心能力

| 模块 | 功能 |
|:--|:--|
| **文献管理** | 本地全文检索（SQLite + FTS5）· BibTeX / RIS / CSV 导入导出 · 引用图谱 · 阅读统计 |
| **学术检索** | Semantic Scholar · arXiv · OpenAlex · CrossRef · PubMed · Unpaywall（13 个 API）|
| **任务系统** | 截止日期追踪 · 四级优先级 · 48h 预警通知 · 任务与文献双向关联 |
| **研究雷达** | 关键词 / 作者 / 期刊监控 · 定时扫描 · Dashboard 新论文推送 |
| **工作区** | Git 追踪文件操作 · 版本历史回溯 · 沙箱路径隔离 |
| **技能生态** | 487 个学术技能 · 13 个 Agent 工具 · 150 个 MCP 配置 |

---

## 架构设计

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Research-Claw                               │
│                                                                     │
│   L0  workspace/                  L2  dashboard/                    │
│       ├─ SOUL.md                      React 18 + Vite 6             │
│       ├─ AGENTS.md                    Ant Design 5 + Zustand 5      │
│       ├─ TOOLS.md                     21 卡片类型 · 6 面板           │
│       ├─ HEARTBEAT.md                 WebSocket RPC v3 客户端        │
│       └─ (8 bootstrap files)          245 i18n keys (EN + ZH-CN)    │
│                                             │                       │
│   L1  extensions/                           │ ws://127.0.0.1:28789  │
│       └─ research-claw-core                 │                       │
│          ├─ 28 tools                        │                       │
│          ├─ 52 WS RPC interfaces            │                       │
│          └─ 13 SQLite tables + FTS5         ▼                       │
│       ╔═══════════════════════════════════════════════════╗         │
│       ║           OpenClaw  (npm dependency)              ║         │
│       ║         Gateway · WS RPC v3 · Port 28789          ║         │
│       ╚═══════════════════════════════════════════════════╝         │
│                              │                                      │
│   L3  patches/               ▼                                      │
│       ~20 lines · 7 files    @wentorai/research-plugins             │
│                              487 skills · 13 tools · 150 MCP        │
└─────────────────────────────────────────────────────────────────────┘
```

### 核心设计决策

| 决策 | 原因 |
|:--|:--|
| **Satellite 而非 Fork** | OpenClaw 作为 npm 依赖引入，上游可随时升级，耦合面控制在 ~20 行 pnpm patch |
| **4 层耦合，从外到内** | L0 文件系统 → L1 插件 SDK → L2 WS RPC → L3 patch，每层独立，可单独替换 |
| **本地优先** | SQLite + WAL 模式，无需数据库服务，断网可完整运行 |
| **技能 > 裸提示词** | 487 个 SKILL.md 结构化封装学术场景，可按研究方向安装/卸载 |
| **端口与上游错开** | 28789（科研龙虾）vs 18789（OpenClaw 默认），两者可并存 |
| **浏览器配置一切** | 无需编辑配置文件，所有设置通过 Setup Wizard 在浏览器完成 |

### 安全模型

科研龙虾采用四层纵深防御，前三层为代码级硬约束：

```
┌──────────────────────────────────────────────┐
│  L1  网络隔离                                 │
│      loopback only · 无远程端口暴露           │
│      无 telemetry · 无云端回传                │
├──────────────────────────────────────────────┤
│  L2  Workspace 沙箱                           │
│      原生 write/edit 工具由 config 层禁用      │
│      插件写文件 = 强制路径校验（拒绝 ../）    │
│      原生 read 保持开放（可读论文/代码）       │
├──────────────────────────────────────────────┤
│  L3  命令执行防护（before_tool_call hook）    │
│      拦截：rm -rf / · dd of=/dev/ · fork bomb │
│      放行：python · git · npm · 单文件 rm     │
├──────────────────────────────────────────────┤
│  L4  Git 版本控制备份                         │
│      workspace 变更自动提交（5s debounce）    │
│      纯本地 · 无 push · 支持全历史回滚        │
├──────────────────────────────────────────────┤
│  L+  提示词级协议（软约束）                   │
│      SOUL.md：禁止伪造引用/数据               │
│      AGENTS.md：不可逆操作需 Human-in-Loop    │
└──────────────────────────────────────────────┘
```

---

## 快速上手

### 系统要求

- macOS（Intel / Apple Silicon）或 Linux
- Git（install 脚本会自动安装）
- Node.js >= 22（install 脚本会自动安装，使用 fnm）
- LLM API Key（推荐 Anthropic Claude 或 OpenAI）

### 安装与启动

```bash
# 方式一：一键安装（推荐）
curl -fsSL https://wentor.ai/install.sh | bash

# 方式二：手动安装
git clone https://github.com/wentorai/Research-Claw.git
cd Research-Claw
pnpm install && pnpm build
pnpm start
```

安装完成后浏览器自动打开 `http://127.0.0.1:28789`，在 **Setup Wizard** 中配置 API Key，无需编辑任何配置文件。

### 常用命令

```bash
pnpm start          # 启动（不更新）
pnpm dev            # 开发模式（Dashboard: localhost:5175）
pnpm test           # 运行单元测试
pnpm health         # 检查运行状态
pnpm backup         # 备份数据库
```

### 更新

```bash
# 重新执行安装脚本即可（自动 git pull + 重新构建）
curl -fsSL https://wentor.ai/install.sh | bash
```

---

## 项目结构

```
research-claw/
├── config/           # OpenClaw 配置覆盖层
│   ├── openclaw.example.json
│   └── openclaw.json          (gitignored)
├── dashboard/        # React + Vite Dashboard
│   └── src/
│       ├── components/        # TopBar, LeftNav, ChatView, panels, cards
│       ├── gateway/           # WS RPC v3 client + hooks
│       ├── i18n/              # en.json + zh-CN.json
│       ├── stores/            # Zustand stores × 7
│       └── types/             # 21 Card type definitions
├── extensions/
│   └── research-claw-core/    # 28 tools · 52 RPC · 13 tables
├── patches/                   # pnpm patch (~20 lines, 7 files)
├── scripts/                   # install / health / backup / sync
├── skills/                    # 自定义 SKILL.md 文件
└── workspace/                 # Bootstrap files (SOUL.md, AGENTS.md …)
```

---

## 社区

<div align="center">

扫码加入**科研龙虾 · WentorOS** 小红书群聊

<img src="assets/community-qr.jpg" width="260" alt="小红书社群二维码" />

[wentor.ai](https://wentor.ai) · [GitHub Issues](https://github.com/wentorai/Research-Claw/issues)

</div>

---

## 许可证

[BSL 1.1](LICENSE) — 个人及学术研究免费使用。商业用途需单独授权，联系 [team@wentor.ai](mailto:team@wentor.ai)。2030-03-12 自动转为 Apache 2.0 开源。

---

<div align="center">
<sub>Built with ❤️ by <a href="https://wentor.ai">Wentor AI</a></sub>
</div>
