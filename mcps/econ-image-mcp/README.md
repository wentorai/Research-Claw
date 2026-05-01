# econ-image-mcp

> 经管研究专用图像生成 MCP —— 把 5 个商业图像模型 + 一套经管 prompt 模板库统一在一组 MCP 工具后面。

`econ-image-mcp` 是 Research Craft Skills / 学研工坊 Skills项目的一部分。它把多个图像生成模型包装在一组统一的 MCP 工具后面，按优先级自动降级，并附带一套针对经管学者的 prompt 模板（政策传导机制 / 博弈论 payoff / 概念图 / Graphical Abstract / 海报 / 政策简报封面）。

```
flux (15) → dalle (20) → imagen (25) → ideogram (30) → recraft (40) → mock (1000)
```

只要任意一个 provider 能用，调用方拿到的都是同一份 `ImageResult` Pydantic 模型；不可用时会自动 fallback，最后回退到 `mock`（合成 PNG，永远可用）。

## Provider 状态

| Provider | 状态 | 说明 |
|----------|------|------|
| `flux`     | 骨架 | Replicate / fal.ai / api.bfl.ml 三种 gateway 任选其一。详见 [`docs/setup-flux.md`](docs/setup-flux.md)。 |
| `dalle`    | **可用** | 需 `OPENAI_API_KEY`。已实现完整 HTTP 调用。详见 [`docs/setup-dalle.md`](docs/setup-dalle.md)。 |
| `imagen`   | 骨架 | 需 GCP 项目 + Vertex AI 服务账号。详见 [`docs/setup-imagen.md`](docs/setup-imagen.md)。 |
| `ideogram` | 骨架 | Replicate gateway。详见 [`docs/setup-ideogram.md`](docs/setup-ideogram.md)。海报 / 政策简报封面首选。 |
| `recraft`  | 骨架 | Replicate / 官方 gateway。详见 [`docs/setup-recraft.md`](docs/setup-recraft.md)。机制图 / Graphical Abstract 首选。 |
| `mock`     | 可用 | 合成 PNG 占位图，主要给测试 / Demo 用。 |

## 安装

```bash
cd econ-image-mcp
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
```

## 跑测试

```bash
.venv/bin/pytest tests/ -v
```

## 暴露的 MCP 工具

| 工具 | 签名 | 说明 |
|------|------|------|
| `generate_image`        | `(prompt, provider=None, size='1024x1024', style=None) -> ImageResult` | 自由 prompt 出图。 |
| `generate_from_template`| `(template_id, params, provider=None, size='1024x1024', style=None) -> ImageResult` | 用经管 prompt 模板出图。 |
| `list_templates`        | `() -> list[TemplateInfo]` | 列出所有 prompt 模板。 |
| `list_providers`        | `() -> list[ProviderStatus]` | 列出 provider 状态（可用 / 不可用 / 优先级）。 |

`provider=None` 时按优先级 fallback；指定具体名字（例如 `provider="dalle"`）则跳过 fallback，直接返回该 provider 的错误。

## Prompt 模板库

模板存在 [`src/econ_image_mcp/prompts/templates.json`](src/econ_image_mcp/prompts/templates.json)，目前 13 个：

| Template id | 场景 |
|---|---|
| `policy-mechanism`         | 政策传导机制示意图（POLICY → CHANNEL → OUTCOME） |
| `game-theory-payoff`       | 2×2 博弈 payoff matrix |
| `concept-illustration`     | 通用概念图（信息不对称 / 网络效应 / 平台经济 等） |
| `graphical-abstract`       | 论文 Graphical Abstract 三段式 |
| `poster-background`        | 学术海报背景（AEA / AOM / SMS） |
| `policy-brief-cover`       | 政策简报封面 |
| `supply-demand-curve`      | 供需曲线 + shift |
| `isoquant-isocost`         | 等产量线 + 等成本线 |
| `phillips-curve-style`     | 菲利普斯曲线（含 NAIRU 与预期偏移） |
| `term-structure-yield-curve` | 利率期限结构 |
| `network-effects`          | 网络效应 / 平台经济 |
| `risk-contagion`           | 系统性金融风险传染 |
| `moral-hazard`             | 委托代理 / 道德风险 |

每个模板有 `title`、`category`、`template`（含 `{PARAM}` 占位符）、`params`、`example`。

## 接入 Claude Desktop

把 [`examples/claude_desktop_config.json`](examples/claude_desktop_config.json) 的内容合进 `~/Library/Application Support/Claude/claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "econ-image": {
      "command": "/abs/path/to/econ-image-mcp/.venv/bin/econ-image-mcp",
      "env": {
        "OPENAI_API_KEY": "sk-...",
        "REPLICATE_API_TOKEN": "rpl_..."
      }
    }
  }
}
```

只配 `OPENAI_API_KEY` 也能跑（DALL-E 即可）；其它 token 留空时对应 provider 走 unavailable + fallback。

## 架构

```
            ┌──────────────────────────┐
            │  FastMCP server          │  src/econ_image_mcp/server.py
            │  4 unified tools         │
            └─────────────┬────────────┘
                          │
                          ▼
            ┌──────────────────────────┐
            │  ProviderRegistry        │  src/econ_image_mcp/registry.py
            │  - priority sort         │
            │  - graceful fallback     │
            └─────────────┬────────────┘
                          │
   ┌──────────┬───────────┼───────────┬───────────┬──────────┐
   ▼          ▼           ▼           ▼           ▼          ▼
 FLUX       DALL-E       Imagen     Ideogram    Recraft     Mock
(skeleton) (HTTP/JSON) (skeleton)  (skeleton)  (skeleton) (synthetic)
```

`BaseImageProvider` 是 ABC，新加 provider 只要继承它实现 `generate` + `is_available`，再 `registry.register(...)`。

## 法律 / 合规

详见 [`NOTICE`](NOTICE)。各厂商图像模型的使用受其各自 terms of service 约束；本仓库只提供调用骨架（DALL-E 已经是完整实现），由用户带 key 使用，禁止把生成的图像拿去做与 OpenAI / Black Forest Labs / Google / Ideogram / Recraft 服务条款冲突的用途。
