# Windows 安装指南

科研龙虾提供两种 Windows 安装方式：

| 方式 | 适合人群 | 复杂度 |
|------|---------|--------|
| **Docker Desktop** (推荐) | 普通用户，开箱即用 | 低 |
| **WSL2** | 需要修改源码或开发调试 | 中 |

---

## 方式一：Docker Desktop（推荐）

无需安装 Node.js、pnpm 或 WSL2，开箱即用。

### 1. 安装 Docker Desktop

下载 [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop/)，安装后重启。

> Docker Desktop 会自动在后台启用 WSL2 作为引擎，你不需要手动配置 WSL。

### 2. 配置镜像加速（大陆必做）

Docker Hub 在大陆无法直接访问。打开 Docker Desktop → **Settings → Docker Engine**，在 JSON 配置中添加：

```json
{
  "registry-mirrors": [
    "https://docker.1panel.live",
    "https://docker.xuanyuan.me"
  ]
}
```

点击 **Apply & Restart**。

> 公共加速器随时可能失效。如果拉取超时，搜索「Docker 镜像加速 2026」获取最新可用地址，或使用阿里云 / 腾讯云控制台申请专属加速器。

### 3. 克隆并启动

打开 PowerShell 或 Windows Terminal：

```powershell
git clone https://github.com/wentorai/Research-Claw.git
cd Research-Claw
docker compose up -d --build
```

首次构建约 5-10 分钟（Dockerfile 已内置清华 apt 源 + npmmirror，构建过程不需要翻墙）。

> **如果 `git clone` 也超时**：编辑 `docker-compose.yml`，取消注释 `build.args` 中的 `HTTP_PROXY` 和 `HTTPS_PROXY`，填入你的代理地址（如 `http://host.docker.internal:7890`）。

### 4. 使用

浏览器打开：

```
http://127.0.0.1:28789/?token=research-claw
```

在 **Setup Wizard** 中填入 API Key，即可使用。

> **Token 认证**：Docker 模式使用 token 认证。默认 token 为 `research-claw`，可通过 `-e OPENCLAW_GATEWAY_TOKEN=your-token` 自定义。
>
> **数据持久化**：数据库、配置、工作区存储在 Docker 具名 volume 中，即使容器删除数据也不丢失。

### Docker 常用操作

```powershell
docker compose up -d          # 启动（后台）
docker compose down            # 停止
docker compose up -d --build   # 重新构建并启动（更新代码后）
docker compose logs -f         # 查看日志
```

---

## 方式二：WSL2 安装

### 前置：安装 WSL2

以**管理员身份**打开 PowerShell：

```powershell
wsl --install -d Ubuntu-24.04
```

安装完成后**重启电脑**，再次打开 Ubuntu 终端，设置用户名和密码。

> 已安装 WSL2 的用户运行 `wsl --update` 确保版本最新。
> 查看已安装的发行版：`wsl --list --verbose`

### 前置：开启 systemd

科研龙虾的后台功能（定时任务、雷达扫描、Gateway 自启动）依赖 systemd。

在 Ubuntu 终端中检查：

```bash
cat /etc/wsl.conf
```

如果没有 `[boot]` 段或缺少 `systemd=true`，执行：

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

然后在 **PowerShell** 中重启 WSL：

```powershell
wsl --shutdown
```

重新打开 Ubuntu 终端，验证 systemd 已启用：

```bash
systemctl --user status
```

> 如果显示 `Failed to connect to bus` 说明 systemd 未生效，请检查 `/etc/wsl.conf` 内容并再次执行 `wsl --shutdown`。

### 安装方式 A：一键脚本（推荐）

WSL2 本质是完整的 Linux 环境，可以直接使用我们的安装脚本：

```bash
curl -fsSL https://wentor.ai/install.sh | bash
```

脚本会自动完成：系统依赖安装 → Node.js 22 → pnpm → 克隆代码 → 编译构建 → 安装插件 → 启动 Gateway。

安装完成后浏览器自动打开 `http://127.0.0.1:28789`，在 Setup Wizard 中配置 API Key。

> **大陆用户**：如果 GitHub 连接超时，先设置代理后再执行：
> ```bash
> export HTTPS_PROXY=http://127.0.0.1:7890
> curl -fsSL https://wentor.ai/install.sh | bash
> ```

后续启动与更新：

```bash
# 日常启动
cd ~/research-claw && pnpm serve

# 更新到最新版
curl -fsSL https://wentor.ai/install.sh | bash
```

> 脚本是幂等的：首次运行 = 安装，后续运行 = 更新 + 启动。

### 安装方式 B：手动安装

适合需要精确控制每一步的开发者。

#### 1. 安装系统依赖

```bash
sudo apt update && sudo apt install -y git curl unzip python3 make g++
```

> `python3 / make / g++` 是编译 `better-sqlite3` 原生模块所需的工具链。
> `unzip` 是 fnm 安装器的必需依赖。

#### 2. 安装 Node.js 22 + pnpm

```bash
# 安装 fnm（Fast Node Manager）
curl -fsSL https://fnm.vercel.app/install | bash
source ~/.bashrc

# 安装 Node.js 22
fnm install 22
fnm use 22
fnm default 22
node -v  # 确认输出 v22.x.x

# 安装 pnpm
npm install -g pnpm@9
```

#### 3. 克隆并构建

```bash
git clone https://github.com/wentorai/Research-Claw.git ~/research-claw
cd ~/research-claw
pnpm install && pnpm build
cp config/openclaw.example.json config/openclaw.json
```

> **大陆用户加速**：如果 npm 依赖下载缓慢，先执行 `npm config set registry https://registry.npmmirror.com`，再运行 `pnpm install`。

#### 4. 启动

```bash
cd ~/research-claw && pnpm serve
```

浏览器打开 `http://127.0.0.1:28789`，在 **Setup Wizard** 中填入 API Key。

> `pnpm serve` 使用自动重启循环 — 修改设置后 Gateway 会自行重启，无需手动操作。
> 按 `Ctrl+C` 停止。

#### 5. 后续启动与更新

```bash
# 日常启动
cd ~/research-claw && pnpm serve

# 更新到最新版
cd ~/research-claw && git pull && pnpm install && pnpm build && pnpm serve
```

---

## 开机自启（可选）

默认情况下每次重启电脑后需要手动打开 Ubuntu 终端并执行 `pnpm serve`。以下方案实现开机自动启动。

### 1. 创建 systemd 用户服务

在 Ubuntu 终端中执行：

```bash
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/research-claw.service <<'EOF'
[Unit]
Description=Research-Claw Gateway
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/research-claw
Environment=OPENCLAW_CONFIG_PATH=./config/openclaw.json
Environment=PATH=%h/.local/share/fnm/aliases/default/bin:%h/.nvm/versions/node/current/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=node ./node_modules/openclaw/dist/entry.js gateway run --allow-unconfigured --auth none --port 28789 --force
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF
```

启用并启动服务：

```bash
systemctl --user daemon-reload
systemctl --user enable research-claw
systemctl --user start research-claw
```

验证运行状态：

```bash
systemctl --user status research-claw --no-pager
```

> 此服务会在每次 WSL 启动时自动运行，且 Gateway 崩溃后自动重启。

### 2. 允许无登录运行用户服务

```bash
sudo loginctl enable-linger "$(whoami)"
```

> 没有这一步的话，用户服务只在该用户登录 WSL 终端时才运行。`enable-linger` 使服务在系统启动后立即运行，无需打开终端。

### 3. Windows 开机自动启动 WSL

在 **PowerShell（管理员）** 中创建计划任务：

```powershell
schtasks /create /tn "WSL Boot" /tr "wsl.exe -d Ubuntu-24.04 --exec /bin/true" /sc onstart /ru SYSTEM
```

> 这会在 Windows 开机时自动启动 WSL Ubuntu 实例，进而触发 systemd 启动 research-claw 服务。
> 查看你的 WSL 发行版名称：`wsl --list --verbose`

### 验证自启动链路

重启电脑后，无需打开任何终端，直接在浏览器访问 `http://127.0.0.1:28789`。

如果无法访问，排查步骤：

```powershell
# 1. 检查 WSL 是否在运行
wsl --list --running
```

```bash
# 2. 检查服务状态（打开 Ubuntu 终端）
systemctl --user status research-claw --no-pager

# 3. 查看服务日志
journalctl --user -u research-claw --no-pager -n 30
```

---

## 代理设置

如果你的网络环境需要代理才能访问 LLM API（如 OpenAI），请按你使用的方式配置：

### Docker

编辑 `docker-compose.yml`，取消注释 `environment` 部分：

```yaml
environment:
  - HTTP_PROXY=http://host.docker.internal:7890
  - HTTPS_PROXY=http://host.docker.internal:7890
```

`host.docker.internal` 是 Docker 容器访问宿主机的标准地址。

### WSL2

在 `~/.bashrc` 末尾添加：

```bash
export HTTP_PROXY=http://127.0.0.1:7890
export HTTPS_PROXY=http://127.0.0.1:7890
```

> WSL2 中 `127.0.0.1` 默认映射到 Windows 宿主机（从 Windows 11 22H2 开始）。如果你使用较旧版本的 Windows，可能需要使用 Windows 主机的实际局域网 IP。

如果使用了 systemd 自启动，还需要将代理写入服务文件：

```bash
systemctl --user edit research-claw
```

添加：

```ini
[Service]
Environment=HTTP_PROXY=http://127.0.0.1:7890
Environment=HTTPS_PROXY=http://127.0.0.1:7890
```

保存后重启服务：`systemctl --user restart research-claw`

---

## FAQ

**Q: Docker 启动后浏览器打不开 Dashboard？**
先在 PowerShell 中运行 `curl http://127.0.0.1:28789/healthz`。如果返回 `{"ok":true,"status":"live"}`，说明 gateway 正常，用 `http://127.0.0.1:28789/?token=research-claw` 访问（注意用 `127.0.0.1`，不要用 `localhost`——Windows 上 `localhost` 可能解析到 IPv6 而 Docker 只绑定了 IPv4）。如果 curl 也报错，重启 Docker Desktop 再试。

**Q: Docker 和 WSL2 应该选哪个？**
Docker Desktop 更简单，一条命令启动，不需要管理 Node.js 版本和依赖。WSL2 适合需要修改源码或进行插件开发的用户。

**Q: 安装后文件在哪？**
- Docker：数据在 Docker volume 中（`docker volume ls` 查看），通过 `http://127.0.0.1:28789` 界面操作。
- WSL2：`~/research-claw`（即 Ubuntu 中的 `/home/<你的用户名>/research-claw`）。

**Q: WSL2 中启动后 Windows 浏览器能访问吗？**
可以。WSL2 的网络默认与 Windows 共享，`http://127.0.0.1:28789` 在 Windows 浏览器中直接可用。

**Q: 如何在 Windows 文件管理器中打开 WSL2 文件？**
地址栏输入 `\\wsl$\Ubuntu-24.04\home\<你的用户名>\research-claw`。

**Q: `pnpm start` 和 `pnpm serve` 有什么区别？**
`pnpm start` 直接启动 Gateway（单次运行）。`pnpm serve` 在外层包了自动重启循环，配置变更后 Gateway 会自动重启。日常使用推荐 `pnpm serve`。

**Q: 如何停止自启动服务？**
```bash
systemctl --user stop research-claw     # 停止
systemctl --user disable research-claw  # 取消自启动
```

**Q: 遇到问题怎么办？**
前往 [GitHub Issues](https://github.com/wentorai/Research-Claw/issues) 报告，附上错误日志。
