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

RUN pnpm install --node-linker=hoisted

# ── 源码 + 构建 ──────────────────────────────────────────────────────
COPY . .

RUN pnpm build

# ── research-plugins（431 skills + 40 indexes + 13 agent tools）────────
# 通过 OpenClaw 插件机制安装到 ~/.openclaw/extensions/（不走 node_modules）
# Note: Use a minimal config for install — the full config references research-plugins
# in plugins.allow, but OC validates that before install completes (chicken-and-egg).
RUN echo '{}' > /tmp/oc-install.json && \
    OPENCLAW_CONFIG_PATH=/tmp/oc-install.json \
    node ./node_modules/openclaw/dist/entry.js \
    plugins install @wentorai/research-plugins && \
    rm /tmp/oc-install.json

# 烘焙配置模板 + 系统提示词到 /defaults/，entrypoint 会同步到 volume
RUN mkdir -p /defaults/bootstrap-prompts && \
    cp config/openclaw.example.json /defaults/openclaw.example.json && \
    cp workspace/.ResearchClaw/AGENTS.md workspace/.ResearchClaw/SOUL.md \
       workspace/.ResearchClaw/TOOLS.md workspace/.ResearchClaw/IDENTITY.md \
       workspace/.ResearchClaw/HEARTBEAT.md /defaults/bootstrap-prompts/ && \
    cp workspace/.ResearchClaw/BOOTSTRAP.md.example \
       workspace/.ResearchClaw/USER.md.example /defaults/bootstrap-prompts/ && \
    cp workspace/MEMORY.md.example /defaults/bootstrap-prompts/ && \
    cp workspace/USER.md.example /defaults/bootstrap-prompts/ws-USER.md.example

# ── 运行时 ───────────────────────────────────────────────────────────
COPY scripts/docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 28789

ENTRYPOINT ["/entrypoint.sh"]
