# Docker Scientific Environment

> v0.5.9 (2026-03-24): Docker 镜像新增 Chromium + Python 科研环境

## 概述

RC Docker 镜像现在包含完整的科研计算环境：

| 组件 | 版本 | 用途 |
|------|------|------|
| Chromium | Playwright 1.58.2 bundled | OC browser tool (headless, CDP) |
| Python | 3.13 (Miniforge3) | 数据分析、可视化、计算 |
| numpy, pandas, scipy | latest | 数值计算、数据处理 |
| matplotlib, seaborn, plotly | latest | 可视化 |
| scikit-learn, statsmodels | latest | ML + 统计 |
| networkx, sympy, biopython | latest | 图论、符号计算、生信 |

## 构建

```bash
# 大陆网络（默认 TUNA 镜像）
docker build -t research-claw .

# 海外网络
docker build \
  --build-arg APT_MIRROR=deb.debian.org \
  --build-arg NPM_REGISTRY=https://registry.npmjs.org \
  -t research-claw .

# 多架构构建 + 推送 GHCR
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --build-arg APT_MIRROR=deb.debian.org \
  --build-arg NPM_REGISTRY=https://registry.npmjs.org \
  -t ghcr.io/wentorai/research-claw:0.5.9 \
  -t ghcr.io/wentorai/research-claw:latest \
  --push .
```

## 验证

```bash
# Python
docker exec research-claw python3 -c "import numpy, pandas, matplotlib; print('OK')"

# Chromium
docker exec research-claw chromium --headless --dump-dom --no-sandbox https://example.com

# Gateway + Plugin
curl -sf http://127.0.0.1:28789/healthz
# 期望: Research-Claw Core registered (38 tools, 79 interfaces, 8 hooks)
```

## 配置迁移

旧 config volume（v0.5.8 之前）没有 `browser` key。`ensure-config.cjs` 第 11 项迁移自动添加：

```json
{ "browser": { "enabled": true, "defaultProfile": "research-claw", ... } }
```

## 注意事项

1. **镜像大小 ~4.4GB** — Chromium 占 ~1.5GB。首次 pull 较慢
2. **pip 而非 conda** — conda 在 BuildKit 中有缓存腐败问题，改用 pip
3. **Chromium symlink** — 依赖 Playwright 内部目录结构，大版本升级需验证
4. **Zotero mount** — 默认启用，宿主路径不存在时 Docker 创建空目录（无报错）
