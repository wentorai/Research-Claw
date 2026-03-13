# ============================================================
# Research-Claw (科研龙虾)
# ============================================================
FROM node:22-slim

# ── 中国大陆网络优化 ────────────────────────────────────────────────────
# 如果你在海外，可以注释掉下面两个 RUN 块，直接用默认源。

# Debian apt 换源 → 清华 TUNA 镜像
RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources

# npm + pnpm 换源 → npmmirror（淘宝）
RUN npm config set registry https://registry.npmmirror.com

# ── 系统依赖 ─────────────────────────────────────────────────────────
# python3/make/g++: better-sqlite3 原生编译
# git/curl/ca-certificates: git+https 依赖拉取
# psmisc: fuser（--force 端口释放需要）
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ git curl ca-certificates psmisc \
    && rm -rf /var/lib/apt/lists/*

# pnpm — match version in package.json
RUN npm install -g pnpm@9.15.0

WORKDIR /app

# GitHub HTTPS 代替 SSH（Docker 内无 SSH key）
# 同时配置 git 代理（如需翻墙，取消注释 HTTP_PROXY 行）
RUN git config --global url."https://github.com/".insteadOf "git@github.com:"
# RUN git config --global http.proxy http://host.docker.internal:7890

# ── 依赖层（package 文件不变则缓存命中）──────────────────────────────
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY patches/ ./patches/
COPY dashboard/package.json                          ./dashboard/
COPY extensions/research-claw-core/package.json     ./extensions/research-claw-core/
COPY extensions/wentor-connect/package.json          ./extensions/wentor-connect/

RUN pnpm install --node-linker=hoisted && \
    # pnpm 用硬链接安装文件 (nlink>1)，OpenClaw 拒绝 nlink>1 的插件文件。
    # cp -r 创建新 inode (nlink=1) 绕过路径校验。
    cp -r node_modules/@wentorai/research-plugins /tmp/rp-clean && \
    rm -rf node_modules/@wentorai/research-plugins && \
    mv /tmp/rp-clean node_modules/@wentorai/research-plugins

# ── 源码 + 构建 ──────────────────────────────────────────────────────
COPY . .

RUN pnpm build

# 烘焙配置模板，首次启动时 entrypoint 会复制到 volume
RUN mkdir -p /defaults && cp config/openclaw.example.json /defaults/openclaw.example.json

# ── 运行时 ───────────────────────────────────────────────────────────
COPY scripts/docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 28789

ENTRYPOINT ["/entrypoint.sh"]
