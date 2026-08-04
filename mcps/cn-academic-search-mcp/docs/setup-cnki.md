# 配置 中国知网 (CNKI) Provider

## 1. 简介

[中国知网 (CNKI)](https://www.cnki.net/) 是国内最权威的中文学术数据库，覆盖核心期刊、CSSCI、博硕士论文、会议论文、报纸、年鉴等。本 MCP 项目中的 `CnkiProvider` 是接口骨架；CNKI 对外不公开通用爬取接口，请仅在合规授权下接入。

## 2. 合规获取访问权限

CNKI 对自动化访问极为敏感，请务必通过下列渠道之一合规接入：

1. **高校 / 科研院所图书馆 IP 授权**：在校园网或学校 VPN 内访问；
2. **学校统一身份认证 (CARSI / CASB / Shibboleth)**：通过学校 SSO 跳转登入 CNKI；
3. **CNKI 开放平台 (OKMS / 知网研学) 商业合同**：与 CNKI 直接签订 API 合同，获取专用 API key；
4. **机构数据交换合同**：如所属单位与 CNKI 有数据互通协议，按协议规范接入。

> 严禁使用账号共享、撞库、爬虫、模拟登录、绕过反爬等任何方式。CNKI 已多次对未授权抓取行为提起诉讼，违规者面临账号封禁、合同终止乃至法律责任。

## 3. 配置环境变量

```bash
export CNKI_TOKEN="<your-institutional-api-key>"
export CNKI_BASE_URL="https://api.your-institution.example.com/cnki"  # 可选
```

`is_available()` 仅检查 `CNKI_TOKEN` 是否非空。

## 4. TODO 实施清单

- [ ] 与 CNKI 商务 / 学校图书馆确认可用 API（OKMS、知网研学、CSSCI 数据接口等）
- [ ] 在 `CnkiProvider` 中实现鉴权（OAuth / 签名 / IP 白名单）
- [ ] 实现 `search()`：注意 CNKI 字段名 (TI/AU/KY/JN/YE) 与本项目 `Paper` 模型的映射
- [ ] 实现 `get_paper()`：基于 CNKI 文献编号 (`cnki:CJFD2023XXXX` 等) 调用详情
- [ ] 处理速率限制与配额：超额时返回 `ProviderUnavailableError`
- [ ] 单测中使用录制的响应 fixture，避免在 CI 中触达真实 CNKI
- [ ] 在 README 与 `examples/claude_desktop_config.json` 中给出配置示例
