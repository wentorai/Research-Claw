# Tushare 配置（推荐先用这个）

Tushare 是目前唯一开源、可免费使用的中国金融数据源，且 `wind-cn-mcp` 已经把它实现到了可工作的程度。

## 1. 注册账号

打开 https://tushare.pro 注册账号。新账户登录后在 “个人主页 → 接口TOKEN” 即可拿到一个 40 位的 token。

## 2. 提升积分（可选）

免费账号可调用基础接口（`daily`, `income`, `balancesheet`, `cashflow`, `cn_gdp`, `cn_cpi` 等）。部分高频或宏观接口需要 ≥120 积分，可通过：
- 完善个人资料（+20）
- 关注公众号绑定（+50）
- 邀请好友 / 付费充值

详见 https://tushare.pro/document/1?doc_id=13。

## 3. 配置环境变量

```bash
export TUSHARE_TOKEN="你的40位token"
```

或写入 `~/.zshrc` / `~/.bashrc`，然后 `source` 一下。

## 4. 验证

```bash
python -c "
import os, asyncio
from wind_cn_mcp.providers.tushare import TushareProvider

async def main():
    p = TushareProvider()
    print('available:', await p.is_available())
    q = await p.get_quote('600519.SH')
    print(q)

asyncio.run(main())
"
```

如果看到一行 `Quote(symbol='600519.SH', price=..., provider='tushare')` 就说明通了。

## 限速

- 免费用户：每分钟 ≤200 次
- 部分接口（资金流、龙虎榜等）有更严格的频率限制

`wind-cn-mcp` 暂未做客户端节流；高频调用请自行加缓存或升级积分。
