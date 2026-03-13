# Windows 安装指南

科研龙虾提供两种 Windows 安装方式。推荐 Docker Desktop，零配置开发环境。

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

浏览器打开 `http://127.0.0.1:28789`，在 **Setup Wizard** 中填入 API Key，即可使用。

> **数据持久化**：数据库、配置、工作区存储在 Docker 具名 volume 中，即使容器删除数据也不丢失。

### Docker 常用操作

```powershell
docker compose up -d          # 启动（后台）
docker compose down            # 停止
docker compose up -d --build   # 重新构建并启动（更新代码后）
docker compose logs -f         # 查看日志
```

---

## 方式二：WSL2 手动安装

适合需要直接接触源码或进行开发调试的用户。

### 1. 安装 WSL2

以**管理员身份**打开 PowerShell：

```powershell
wsl --install -d Ubuntu
```

安装完成后**重启电脑**，再次打开 Ubuntu 终端，设置用户名和密码。

> 已安装 WSL2 的用户运行 `wsl --update` 确保版本最新。

### 2. 开启 systemd

科研龙虾的部分后台功能（如定时任务、雷达扫描）依赖 systemd。在 Ubuntu 终端中检查：

```bash
cat /etc/wsl.conf
```

如果没有 `[boot]` 段或缺少 `systemd=true`，执行：

```bash
echo -e "[boot]\nsystemd=true" | sudo tee /etc/wsl.conf
```

然后在 **PowerShell** 中重启 WSL：

```powershell
wsl --shutdown
```

重新打开 Ubuntu 终端。

### 3. 安装 Node.js 22 + pnpm

```bash
# 安装 fnm（Fast Node Manager）
curl -fsSL https://fnm.vercel.app/install | bash
source ~/.bashrc

# 安装 Node.js 22
fnm install 22
fnm use 22
node -v  # 确认输出 v22.x.x

# 安装 pnpm
npm install -g pnpm@9.15.0
```

### 4. 安装系统依赖

```bash
sudo apt update && sudo apt install -y git curl python3 make g++
```

> `python3 / make / g++` 是编译 `better-sqlite3` 原生模块所需的工具链。

### 5. 克隆并构建

```bash
git clone https://github.com/wentorai/Research-Claw.git ~/research-claw
cd ~/research-claw
pnpm install && pnpm build
cp config/openclaw.example.json config/openclaw.json
```

> **大陆用户加速**：如果 npm 依赖下载缓慢，先执行 `npm config set registry https://registry.npmmirror.com`，再运行 `pnpm install`。

### 6. 启动

```bash
cd ~/research-claw && pnpm start
```

浏览器打开 `http://127.0.0.1:28789`，在 **Setup Wizard** 中填入 API Key。

> 所有配置通过浏览器完成，无需手动编辑配置文件。

### 7. 后续启动与更新

```bash
# 日常启动
cd ~/research-claw && pnpm start

# 更新到最新版
cd ~/research-claw && git pull && pnpm install && pnpm build && pnpm start
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

---

## FAQ

**Q: Docker 和 WSL2 应该选哪个？**
Docker Desktop 更简单，一条命令启动，不需要管理 Node.js 版本和依赖。WSL2 手动安装适合需要修改源码或进行插件开发的用户。

**Q: 安装后文件在哪？**
- Docker：数据在 Docker volume 中（`docker volume ls` 查看），通过 `http://127.0.0.1:28789` 界面操作。
- WSL2：`~/research-claw`（即 Ubuntu 中的 `/home/<你的用户名>/research-claw`）。

**Q: WSL2 中启动后 Windows 浏览器能访问吗？**
可以。WSL2 的网络默认与 Windows 共享，`http://127.0.0.1:28789` 在 Windows 浏览器中直接可用。

**Q: 如何在 Windows 文件管理器中打开 WSL2 文件？**
地址栏输入 `\\wsl$\Ubuntu\home\<你的用户名>\research-claw`。
