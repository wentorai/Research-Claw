# 配置 维普 (CqVip / VIP) Provider

## 1. 简介

[维普资讯](https://www.cqvip.com/) 是国内三大中文学术全文数据库之一，与万方、知网并列。本 MCP 项目中的 `CqVipProvider` 同样仅是接口骨架，需要拥有机构访问权限的用户自行实现具体请求与解析。

## 2. 合规获取访问权限

请通过以下渠道之一合规接入：

1. **高校图书馆 IP 授权**：校园网 / 学校 VPN 下默认登入维普；
2. **学校 SSO / CARSI 单点登录**；
3. **机构 API 合同**：维普的机构客户可向商务获取 API key 或定制接口；
4. **官方开放接口**：以维普官方公告为准。

> 严禁使用账号共享、爬虫、自动化模拟登录等方式绕过认证。维普明确禁止未经授权的数据抓取与转售。

## 3. 配置环境变量

```bash
export CQVIP_TOKEN="<your-institutional-token>"
export CQVIP_BASE_URL="https://api.your-institution.example.com/cqvip"  # 可选
```

## 4. TODO 实施清单

- [ ] 与维普商务确认可用接口与配额
- [ ] 在 `CqVipProvider` 中读取 `CQVIP_TOKEN` / 基础 URL
- [ ] 实现 `search()` 与 `get_paper()`，覆盖期刊、学位论文等常用类型
- [ ] 字段映射到 `Paper` / `AuthorInfo`，处理中英文字段差异
- [ ] 错误处理：401/403/429 → `ProviderUnavailableError` 或抛 NotImplementedError 的派生异常
- [ ] 加入 mock-only 单测，杜绝 CI 中真实网络调用
