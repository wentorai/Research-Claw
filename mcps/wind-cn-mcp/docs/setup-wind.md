# Wind 万得 配置（需付费终端）

> Wind 是商业金融终端，本仓库**只提供 Provider 骨架**，具体的 `w.wsq()` / `w.wsd()` / `w.wss()` / `w.edb()` 调用需要由有 license 的用户自行实现。

## 1. 安装 Wind 金融终端

向 Wind 销售（机构购买）或学校机房管理员申请安装包，按指引登录。

- Windows：原生支持，COM 客户端开箱即用
- macOS：需要装 “Wind Mac 版” 客户端

终端必须保持登录状态，`WindPy` 才能复用其会话。

## 2. 安装 WindPy

```bash
pip install WindPy
```

WindPy 由 Wind 官方分发，pip 包是注册账号才能下载。安装后必须执行：

```python
from WindPy import w
w.start()  # 阻塞直到 COM/客户端连上
assert w.isconnected()
```

## 3. 完成 `WindProvider`

打开 `src/wind_cn_mcp/providers/wind.py`，把 `NotImplementedError` 替换成真正的 wsq/wsd/wss/edb 调用：

```python
async def get_quote(self, symbol: str) -> Quote:
    from WindPy import w
    res = w.wsq(symbol, "rt_last,rt_chg,rt_pct_chg,rt_vol,rt_amt")
    if res.ErrorCode != 0:
        raise ProviderAPIError(f"wsq failed: {res.Data}")
    ...
```

> 提示：WindPy 是同步阻塞 API，建议用 `anyio.to_thread.run_sync` 包一层避免堵塞 event loop。

## 4. 许可与合规

Wind 数据严格禁止转售、二次分发、向终端外的服务暴露。本 MCP 仅在你**本人持牌**的本地机器上调用，作为科研工作流的一环。`Wind 客户协议` 第 7 条明确：未经授权将数据通过 API 提供给第三方将被追责。
