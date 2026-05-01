# 东方财富 Choice 配置（需付费终端）

> Choice 是东方财富 Choice 金融终端的 Python SDK（包名 `EmQuantAPI`），本仓库**只提供 Provider 骨架**。

## 1. 安装 Choice 终端 + EmQuantAPI

1. 在 https://choice.eastmoney.com 申请账号；
2. 下载并登录 Choice 客户端；
3. 在客户端 “量化接口 → Python” 安装 `EmQuantAPI`（注意区分 32-bit / 64-bit）。

## 2. 登录

```python
from EmQuantAPI import c

ret = c.start("ForceLogin=1")
assert ret.ErrorCode == 0, ret.ErrorMsg
```

## 3. 完成 `ChoiceProvider`

替换 `src/wind_cn_mcp/providers/choice.py` 中的 `NotImplementedError`：

| 方法 | EmQuantAPI |
| ---- | ---------- |
| `get_quote` | `c.csqsnapshot(codes, indicators)` |
| `get_history` | `c.csd(codes, indicators, start, end)` |
| `get_financials` | `c.css(codes, indicators, params)` |
| `get_macro` | `c.edb(indicator, start, end)` |

注意 EmQuantAPI 的返回是命名结构（`.Data`, `.Dates`, `.Codes`），按列拆开后再装进我们的 Pydantic 模型。

## 4. 合规

Choice 用户协议禁止数据二次分发；仅在你**本人持牌**的机器上跑。
