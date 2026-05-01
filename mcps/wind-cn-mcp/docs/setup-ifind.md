# 同花顺 iFinD 配置（需付费终端）

> iFinD 是同花顺的金融数据终端，本仓库**只提供 Provider 骨架**。

## 1. 安装 iFinD 客户端 + iFinDPy

1. 在 https://ft.10jqka.com.cn 申请试用 / 购买账号；
2. 下载 iFinD 客户端（Windows / Mac），登录账号一次以激活；
3. 在客户端 “帮助 → 数据接口 → Python” 下载并按提示安装 `iFinDPy`。

## 2. 登录

```python
from iFinDPy import THS_iFinDLogin

ret = THS_iFinDLogin("账号", "密码")
assert ret == 0, f"login failed: {ret}"
```

## 3. 完成 `IFindProvider`

替换 `src/wind_cn_mcp/providers/ifind.py` 中的 `NotImplementedError`：

| 方法 | iFinDPy API |
| ---- | ----------- |
| `get_quote` | `THS_RealtimeQuotes(thsCode, indicators)` |
| `get_history` | `THS_HistoryQuotes(thsCode, indicators, params, start, end)` |
| `get_financials` | `THS_BasicData(thsCode, indicators, params)` |
| `get_macro` | `THS_DateSerial(...)` 或 `THS_DataPool(...)` |

返回值的 `errorcode != 0` 时应抛 `ProviderAPIError` 让 registry 走 fallback。

## 4. 合规

同花顺 iFinD 用户协议禁止数据二次分发。仅在你**本人持牌**的机器上跑这个 MCP。
