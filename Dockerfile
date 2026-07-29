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
      ffmpeg \
      pandoc texlive-xetex texlive-latex-recommended lmodern \
      fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# pnpm — exact match with packageManager in package.json and native installer
RUN npm install -g pnpm@10.34.4

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
# Default: TUNA mirror (China mainland). Fallback: GitHub releases.
RUN ARCH="$(uname -m)" \
    && (curl -fsSL --connect-timeout 10 "https://mirrors.tuna.tsinghua.edu.cn/github-release/conda-forge/miniforge/LatestRelease/Miniforge3-Linux-${ARCH}.sh" \
        -o /tmp/miniforge.sh 2>/dev/null \
    || curl -fsSL "https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-${ARCH}.sh" \
        -o /tmp/miniforge.sh) \
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
      'markitdown[all]' markitdown-mcp \
    && /opt/miniforge3/bin/python3 -c "import numpy; print(f'numpy {numpy.__version__} OK')" \
    && /opt/miniforge3/bin/python3 -c "import markitdown; print(f'markitdown {markitdown.__version__} OK')"

ENV PATH="/opt/miniforge3/bin:$PATH"

# ── uv / uvx (sci-papers-downloder Sci-Hub fallback) ─────────────────
# sci-papers-downloder's downloader runs `--scihub-fallback auto` by default and
# resolves the Sci-Hub command in order: --scihub-cmd → PATH `scihub-cli` →
# `uvx --from git+https://github.com/Oxidane-bot/scihub-cli.git scihub-cli`.
# Linux/Docker ships neither scihub-cli nor uv, so the fallback silently no-ops.
# Install uv (provides uvx) so the 3rd resolution path works on demand; scihub-cli
# itself is fetched lazily at first use (kept out of image layers). Non-fatal:
# Sci-Hub is an optional last resort — never break the build over it.
RUN set +e; \
    curl -fsSL https://astral.sh/uv/install.sh | sh; \
    ln -sf /root/.local/bin/uv  /usr/local/bin/uv; \
    ln -sf /root/.local/bin/uvx /usr/local/bin/uvx; \
    echo "[build] uv for sci-hub fallback: $(command -v uvx || echo 'unavailable (optional)')"; \
    exit 0

# ── 依赖层（package 文件不变则缓存命中）──────────────────────────────
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY patches/ ./patches/
COPY scripts/prepare-package-manager.cjs ./scripts/
COPY dashboard/package.json                          ./dashboard/
COPY extensions/dual-model-supervisor/package.json  ./extensions/dual-model-supervisor/
COPY extensions/research-claw-core/package.json     ./extensions/research-claw-core/
COPY extensions/research-superpower/package.json    ./extensions/research-superpower/
COPY extensions/wentor-connect/package.json          ./extensions/wentor-connect/
COPY extensions/openclaw-weixin/package.json         ./extensions/openclaw-weixin/

# --node-linker=hoisted: Required in Docker to avoid pnpm symlink issues
# with better-sqlite3 native module resolution. Native install uses the
# default (symlinked) linker which works fine outside containers.
RUN pnpm install --node-linker=hoisted

# ── 源码 + 构建 ──────────────────────────────────────────────────────
COPY . .

# The Docker release includes ppt-master's runtime skill from the pinned
# submodule, but .dockerignore excludes its repository history and examples.
# Fail here instead of publishing an image whose PPT tools silently cannot run.
RUN test -f ppt-master/skills/ppt-master/scripts/project_manager.py && \
    test -f ppt-master/skills/ppt-master/scripts/svg_to_pptx.py

RUN pnpm build

# ── research-plugins (skills + indexes + agent tools via OC plugin) ───
# Bake to /defaults/ so the rc-state volume (mounts at /root/.openclaw) does
# not shadow it. Entrypoint copies /defaults/research-plugins → the volume on
# first boot / version change (instant, no network needed at runtime).
# `openclaw plugins install` (OC 2026.6.1) installs into a temp npm projects
# dir, NOT ~/.openclaw/extensions, so extract the npm tarball directly —
# deterministic and offline-safe. Fail the build if catalog.json is missing.
RUN mkdir -p /defaults/research-plugins && cd /tmp && \
    npm pack @wentorai/research-plugins && \
    tar xzf wentorai-research-plugins-*.tgz -C /defaults/research-plugins --strip-components=1 && \
    rm -f wentorai-research-plugins-*.tgz && \
    # The plugin (main: dist/index.js) imports @sinclair/typebox at load; the raw
    # tarball ships no node_modules, so install prod deps or the plugin fails to
    # load (losing all agent tools). --ignore-scripts: typebox is pure JS.
    ( cd /defaults/research-plugins && npm install --omit=dev --ignore-scripts --no-audit --no-fund ) && \
    test -f /defaults/research-plugins/node_modules/@sinclair/typebox/package.json && \
    test -f /defaults/research-plugins/catalog.json && \
    node -e "process.stdout.write(require('/defaults/research-plugins/package.json').version)" \
    > /defaults/rp-version.txt && \
    echo "[build] baked research-plugins $(cat /defaults/rp-version.txt) with catalog.json + deps"

# 烘焙配置模板 + 系统提示词到 /defaults/，entrypoint 会同步到 volume
RUN mkdir -p /defaults/bootstrap-prompts && \
    cp config/openclaw.example.json /defaults/openclaw.example.json && \
    cp config/research-compaction-instructions.txt /defaults/research-compaction-instructions.txt && \
    # L1 system prompts (version-gated refresh at container start)
    cp workspace/.ResearchClaw/AGENTS.md \
       workspace/.ResearchClaw/HEARTBEAT.md /defaults/bootstrap-prompts/ && \
    # L3 user-owned + L2 onboarding templates (copied only if missing)
    cp workspace/.ResearchClaw/SOUL.md.example \
       workspace/.ResearchClaw/IDENTITY.md.example \
       workspace/.ResearchClaw/TOOLS.md.example \
       workspace/.ResearchClaw/BOOTSTRAP.md.example \
       workspace/.ResearchClaw/USER.md.example /defaults/bootstrap-prompts/ && \
    cp workspace/MEMORY.md.example /defaults/bootstrap-prompts/

# ── 运行时 ───────────────────────────────────────────────────────────
# CLI wrapper: 让 `openclaw` 命令在容器内直接可用
# (openclaw 是 local dependency，不在 PATH；用户 docker exec 时需要)
RUN printf '#!/bin/sh\nexec node /app/node_modules/openclaw/dist/entry.js "$@"\n' > /usr/local/bin/openclaw \
    && chmod +x /usr/local/bin/openclaw

COPY scripts/docker-entrypoint.sh /entrypoint.sh
# Strip Windows CRLF line endings — git clone on Windows with core.autocrlf=true
# converts LF→CRLF, causing "exec /entrypoint.sh: no such file or directory"
# because the shebang becomes #!/bin/sh\r (not a valid interpreter path).
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

# Keep release metadata after dependency/build layers. Changing only the Git
# revision must not invalidate the multi-gigabyte scientific runtime cache.
ARG RC_BUILD_COMMIT=unknown
ENV RC_BUILD_COMMIT=${RC_BUILD_COMMIT}
LABEL org.opencontainers.image.revision=${RC_BUILD_COMMIT}

EXPOSE 28789

ENTRYPOINT ["/entrypoint.sh"]
