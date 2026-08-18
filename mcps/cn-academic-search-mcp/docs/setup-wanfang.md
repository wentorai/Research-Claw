# 配置 万方数据 (Wanfang) Provider

## 1. 简介

[万方数据](https://www.wanfangdata.com.cn/) 是国内主流学术资源平台之一，覆盖期刊、学位论文、会议论文、专利、标准等。本 MCP 项目中的 `WanfangProvider` 仅提供**接口骨架**：所有方法默认抛出 `NotImplementedError`，需要具备机构访问权限的用户自行实现实际请求逻辑。

## 2. 合规获取访问权限

请通过下列**合规渠道**之一获得访问令牌或 IP 授权：

1. **高校 / 研究院图书馆 IP 白名单**：在校园网或学校 VPN 内访问万方，由学校与万方签订的机构合同覆盖。
2. **学校统一身份认证 (CARSI / CASB)**：通过学校 SSO 跳转登录万方，会话内可使用相关 API。
3. **企业 / 机构合同**：如所属单位与万方签有 API 合同，请向万方商务获取 `API key` 与签名规则。
4. **官方公开 API**（若开放）：以万方官方文档为准，遵守速率与字段限制。

> 严禁通过爬虫绕过登录、共享账号、规避反爬机制等方式获取数据。任何非授权抓取均违反《著作权法》《反不正当竞争法》及万方平台的服务条款。

## 3. 配置环境变量

```bash
export WANFANG_TOKEN="<your-institutional-token>"
# 可选：自建代理 / 网关地址
export WANFANG_BASE_URL="https://api.your-institution.example.com/wanfang"
```

`is_available()` 仅检查 `WANFANG_TOKEN` 是否非空，因此设置后该 provider 会被纳入 fallback 链。

## 4. TODO 实施清单

接手本 provider 时建议按下列顺序补全：

- [ ] 阅读机构合同 / 官方 API 文档，确认可用接口与速率限制
- [ ] 在 `WanfangProvider.__init__` 中读取 `WANFANG_TOKEN`、`WANFANG_BASE_URL` 等配置
- [ ] 实现 `search()`：将 `query` + 过滤参数映射到万方搜索 API
- [ ] 实现 `get_paper()`：基于 `wanfang:<内部ID>` 调用详情接口
- [ ] 在响应解析层将万方字段映射到 `Paper` / `AuthorInfo` 模型
- [ ] 处理鉴权失效 / 速率限制，必要时抛出 `ProviderUnavailableError`
- [ ] 在 `tests/` 中加入 cassette / VCR 风格的回放测试，确保不依赖真实网络
- [ ] 更新 README 与 `examples/claude_desktop_config.json`，提示用户配置令牌
