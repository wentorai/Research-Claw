# ============================================================
# Research-Claw (科研龙虾)
# ============================================================
FROM node:22-slim

# ── Mirror configuration ──────────────────────────────────────────────
# Defaults: China mainland mirrors (TUNA + npmmirror).
# Overseas: docker build --build-arg APT_MIRROR=deb.debian.org --build-arg NPM_REGISTRY=https://registry.npmjs.org .
ARG APT_MIRROR=mirrors.tuna.tsinghua.edu.cn
ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG CONDA_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/anaconda

# Debian apt mirror
RUN sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources

# npm + pnpm registry
RUN npm config set registry ${NPM_REGISTRY}

# ── 系统依赖 ─────────────────────────────────────────────────────────
# python3/make/g++: better-sqlite3 原生编译
# git/curl/ca-certificates: git+https 依赖拉取
# psmisc: fuser（--force 端口释放需要）
# procps: ps（进程管理）
# wget/xdg-utils: Playwright Chromium 安装依赖
# pandoc: workspace_export 二进制文档转换 (md→docx/pdf, Issue #38)
# texlive-xetex/texlive-latex-recommended: pandoc PDF 引擎 (xelatex)
# fonts-noto-cjk: 中日韩字体，确保 docx/pdf 中文渲染正确
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ git curl ca-certificates psmisc procps wget xdg-utils \
      pandoc texlive-xetex texlive-latex-recommended lmodern \
      fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# pnpm — match version in package.json
RUN npm install -g pnpm@9.15.0

WORKDIR /app

# GitHub HTTPS 代替 SSH（Docker 内无 SSH key）
RUN git config --global url."https://github.com/".insteadOf "git@github.com:"
# 构建时代理（如需翻墙，取消注释）
# RUN git config --global http.proxy http://host.docker.internal:7890

# ── Chromium (headless) for OC browser tool ──────────────────────────
# OC's browser tool uses playwright-core (CDP client) and searches for
# /usr/bin/chromium on Linux. Install Playwright's bundled Chromium with
# all system dependencies, then symlink for OC auto-discovery.
# --with-deps installs all required system libraries (libglib, libnss, etc.)
RUN npx playwright-core@1.58.2 install --with-deps chromium \
    && CHROMIUM_PATH="$(find /root/.cache/ms-playwright -name chrome -type f | head -1)" \
    && if [ -n "$CHROMIUM_PATH" ]; then ln -sf "$CHROMIUM_PATH" /usr/bin/chromium; fi \
    && rm -rf /var/lib/apt/lists/*

# ── Miniforge3 (scientific Python) ───────────────────────────────────
# Provides conda + Python for agent's system.run data analysis/visualization.
# Installed to /opt/miniforge3 — does not conflict with system python3.
RUN ARCH="$(uname -m)" \
    && curl -fsSL "https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-${ARCH}.sh" \
       -o /tmp/miniforge.sh \
    && bash /tmp/miniforge.sh -b -p /opt/miniforge3 \
    && rm /tmp/miniforge.sh

# Install scientific Python packages via pip (more reliable in Docker than conda).
# Miniforge provides the base Python; pip handles package installation.
# China mirror: pip defaults to TUNA via PIP_INDEX_URL if NPM_REGISTRY is npmmirror.
# Verify with a test import to catch silent install failures.
RUN PIP_INDEX_URL="$(echo ${NPM_REGISTRY} | grep -q npmmirror && echo https://pypi.tuna.tsinghua.edu.cn/simple || echo https://pypi.org/simple)" \
    && /opt/miniforge3/bin/pip install --no-cache-dir -i "$PIP_INDEX_URL" \
      numpy pandas scipy matplotlib seaborn plotly \
      scikit-learn statsmodels \
      openpyxl xlsxwriter tabulate \
      requests beautifulsoup4 \
      networkx sympy biopython \
      nbformat jupyter-core \
      svgwrite cairosvg \
    && /opt/miniforge3/bin/python3 -c "import numpy; print(f'numpy {numpy.__version__} OK')"

ENV PATH="/opt/miniforge3/bin:$PATH"

# ── 依赖层（package 文件不变则缓存命中）──────────────────────────────
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY patches/ ./patches/
COPY dashboard/package.json                          ./dashboard/
COPY extensions/research-claw-core/package.json     ./extensions/research-claw-core/
COPY extensions/wentor-connect/package.json          ./extensions/wentor-connect/
COPY extensions/openclaw-weixin/package.json         ./extensions/openclaw-weixin/

# --node-linker=hoisted: Required in Docker to avoid pnpm symlink issues
# with better-sqlite3 native module resolution. Native install uses the
# default (symlinked) linker which works fine outside containers.
RUN pnpm install --node-linker=hoisted

# ── 源码 + 构建 ──────────────────────────────────────────────────────
COPY . .

RUN pnpm build

# ── research-plugins (skills + indexes + agent tools via OC plugin) ───
# Installed to ~/.openclaw/extensions/ (not node_modules).
# Use a minimal temp config to avoid chicken-and-egg issues with OC
# plugin validation during install.
RUN echo '{}' > /tmp/oc-install.json && \
    OPENCLAW_CONFIG_PATH=/tmp/oc-install.json \
    node ./node_modules/openclaw/dist/entry.js \
    plugins install @wentorai/research-plugins && \
    rm /tmp/oc-install.json

# Save baked plugin version for entrypoint to sync on upgrade.
# Must run AFTER plugins install and BEFORE /defaults/ copy block.
RUN mkdir -p /defaults && \
    node -e "process.stdout.write(require('/root/.openclaw/extensions/research-plugins/package.json').version)" \
    > /defaults/rp-version.txt 2>/dev/null || echo "unknown" > /defaults/rp-version.txt

# 烘焙配置模板 + 系统提示词到 /defaults/，entrypoint 会同步到 volume
RUN mkdir -p /defaults/bootstrap-prompts && \
    cp config/openclaw.example.json /defaults/openclaw.example.json && \
    # L1 system prompts (force-updated on every container start)
    cp workspace/.ResearchClaw/AGENTS.md \
       workspace/.ResearchClaw/HEARTBEAT.md /defaults/bootstrap-prompts/ && \
    # L3 user-owned + L2 onboarding templates (copied only if missing)
    cp workspace/.ResearchClaw/SOUL.md.example \
       workspace/.ResearchClaw/IDENTITY.md.example \
       workspace/.ResearchClaw/TOOLS.md.example \
       workspace/.ResearchClaw/BOOTSTRAP.md.example \
       workspace/.ResearchClaw/USER.md.example /defaults/bootstrap-prompts/ && \
    cp workspace/MEMORY.md.example /defaults/bootstrap-prompts/ && \
    cp workspace/USER.md.example /defaults/bootstrap-prompts/ws-USER.md.example

# ── 运行时 ───────────────────────────────────────────────────────────
# CLI wrapper: 让 `openclaw` 命令在容器内直接可用
# (openclaw 是 local dependency，不在 PATH；用户 docker exec 时需要)
RUN printf '#!/bin/sh\nexec node /app/node_modules/openclaw/dist/entry.js "$@"\n' > /usr/local/bin/openclaw \
    && chmod +x /usr/local/bin/openclaw

COPY scripts/docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 28789

ENTRYPOINT ["/entrypoint.sh"]
