# wind-cn-mcp

> 中国金融数据终端的统一 MCP 适配器 —— Wind 万得 / 同花顺 iFinD / 东方财富 Choice / Tushare 一套工具搞定。

`wind-cn-mcp` 是 Research-Claw（科研龙虾）项目的一部分。它把 4 个常见的中国金融数据源包装在统一的 MCP 工具集后面，并按照优先级自动降级：

```
wind (10) → ifind (20) → choice (30) → tushare (50) → mock (1000)
```

只要任意一个 provider 能用，调用方拿到的就是同一份 Pydantic 模型；商业终端 unavailable 时会自动 fallback 到 Tushare（开源），最后回退到 Mock（合成数据，永远可用）。

## 状态

| Provider | 状态 | 说明 |
|----------|------|------|
| `wind`    | 骨架  | 需要本机 Wind 终端 + WindPy + license。详见 [`docs/setup-wind.md`](docs/setup-wind.md)。 |
| `ifind`   | 骨架  | 需要同花顺 iFinD 客户端 + iFinDPy。详见 [`docs/setup-ifind.md`](docs/setup-ifind.md)。 |
| `choice`  | 骨架  | 需要东方财富 Choice + EmQuantAPI。详见 [`docs/setup-choice.md`](docs/setup-choice.md)。 |
| `tushare` | **可用**  | 仅需注册免费 token。详见 [`docs/setup-tushare.md`](docs/setup-tushare.md)。 |
| `mock`    | 可用  | 合成数据，主要给测试 / Demo 用。 |

## 安装

```bash
cd wind-cn-mcp
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
```

## 跑测试

```bash
.venv/bin/pytest tests/ -v
```

## 暴露的 MCP 工具

| 工具 | 签名 |
|------|------|
| `get_quote`      | `(symbol, provider=None) -> Quote` |
| `get_history`    | `(symbol, start, end, freq='D', provider=None) -> list[HistoryBar]` |
| `get_financials` | `(symbol, statement, period, provider=None) -> FinancialStatement`<br>`statement ∈ {income, balance, cashflow}` |
| `get_macro`      | `(indicator, start, end, provider=None) -> MacroSeries` |
| `list_providers` | `() -> list[ProviderStatus]` |

`provider=None` 时按优先级 fallback；指定具体名字（例如 `provider="tushare"`）则跳过 fallback，直接返回该 provider 的错误。

## 接入 Claude Desktop

把 `examples/claude_desktop_config.json` 的内容合并进 `~/Library/Application Support/Claude/claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "wind-cn": {
      "command": "/abs/path/to/wind-cn-mcp/.venv/bin/wind-cn-mcp",
      "env": {
        "TUSHARE_TOKEN": "你的token"
      }
    }
  }
}
```

重启 Claude Desktop 后即可在对话里调用 `get_quote`、`get_history` 等。

## 架构

```
            ┌──────────────────────┐
            │  FastMCP server      │  src/wind_cn_mcp/server.py
            │  (5 unified tools)   │
            └─────────┬────────────┘
                      │
                      ▼
            ┌──────────────────────┐
            │  ProviderRegistry    │  src/wind_cn_mcp/registry.py
            │  - priority sort     │
            │  - graceful fallback │
            └─────────┬────────────┘
                      │
        ┌─────────────┼─────────────┬─────────────┬───────────┐
        ▼             ▼             ▼             ▼           ▼
     Wind          iFinD         Choice        Tushare       Mock
   (skeleton)    (skeleton)    (skeleton)    (HTTP/JSON)  (synthetic)
```

`BaseProvider` 是 ABC，新加 provider 只需要继承它实现 5 个方法，再 `registry.register(...)`。

## 法律 / 合规

详见 [`NOTICE`](NOTICE)。Wind / iFinD / Choice 的数据使用受各自厂商协议约束；本仓库**只提供调用骨架**，由持牌用户自行填空，禁止把这些 provider 拿去做对外服务或转售。
