# nsfc-mcp

为 Claude Desktop / Claude Code 等支持 [Model Context Protocol](https://modelcontextprotocol.io/) 的客户端提供
**国家自然科学基金 (NSFC) 公开立项数据查询能力**的 MCP 服务器。

> 项目隶属 **Research-Claw (科研龙虾)**。
> 灵感来自社区项目 [`suqingdong/nsfc`](https://github.com/suqingdong/nsfc)。本仓库
> **从零独立实现**，不复制其源码；HTTP 端点取自 NSFC 公开站点
> (`https://kd.nsfc.cn`, `https://www.nsfc.gov.cn`)。

---

## 特性

- 5 个 MCP 工具：项目检索、详情、年度趋势、学科树、关键词共现
- 异步 `httpx` 客户端 + 简单的令牌桶限速 (默认 1 req/sec)
- 429 自动重试一次；超时/5xx/鉴权错误统一抛出 `NsfcError` 家族
- 全部输出为 Pydantic v2 模型，自动序列化为结构化 JSON 给上游 LLM
- 完整的 `pytest-httpx` 离线测试，零外部网络依赖

## 安装

```bash
git clone <this-repo>
cd nsfc-mcp
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

## 配置 Claude Desktop / Claude Code

把下面的片段加进 `claude_desktop_config.json` 或
`~/.config/claude-code/mcp.json`：

```json
{
  "mcpServers": {
    "nsfc": {
      "command": "python",
      "args": ["-m", "nsfc_mcp"],
      "env": {
        "NSFC_BASE_URL": "https://kd.nsfc.cn"
      }
    }
  }
}
```

如未来 NSFC 开放 token 鉴权，可加 `"NSFC_TOKEN": "..."`。

## 工具一览

| 工具                  | 用途                          |
|-----------------------|-------------------------------|
| `search_projects`     | 多条件检索立项项目列表        |
| `get_project_detail`  | 按批准号获取单项目详情        |
| `get_trends`          | 关键词年度立项数趋势          |
| `list_disciplines`    | 列出学科代码树                |
| `suggest_keywords`    | 关键词共现统计 (基于检索结果) |

### 1. `search_projects`

```python
search_projects(
    keyword="图神经网络",
    institution="清华大学",
    project_type="面上项目",
    discipline_code="F0211",
    year=2022,
    page=1,
    page_size=20,
)
```

返回：`ProjectListResult { total, page, page_size, items: [Project, ...] }`

### 2. `get_project_detail`

```python
get_project_detail(project_id="62076123")
```

返回 `ProjectDetail`：包含中英文摘要、关键词、研究期限等。

### 3. `get_trends`

```python
get_trends(keyword="联邦学习", year_from=2018, year_to=2025)
```

返回逐年立项数与可选立项金额。

### 4. `list_disciplines`

```python
list_disciplines()              # 学部级
list_disciplines("F02")         # F02 (计算机科学) 下的子学科
```

### 5. `suggest_keywords`

```python
suggest_keywords(topic="可解释AI", limit=20)
```

基于命中项目的 `keywords` 字段做共现统计，返回与 `topic` 高频共现的关键词列表。

## 在 Claude Code 中调用样例

```
> 帮我用 nsfc 工具查 2022 年清华大学关于"图神经网络"的面上项目，
> 然后画一下"图神经网络"近 5 年的立项趋势。
```

Claude 会自动选择 `search_projects` + `get_trends`。

## 开发

```bash
pytest tests/ -v
```

测试全部使用 `pytest-httpx` 拦截 HTTP，因此无需访问真实 NSFC 服务器。

## 法律声明

- 仅供 **学术研究** 使用。
- 调用前请阅读 NSFC 公开网站的 `robots.txt` 与服务条款；不得用于商业批量爬取。
- 默认 1 req/sec 的限速是为了对上游友好，请勿调高至超过 NSFC 实际容许的并发。
- 本项目不提供也不存储任何 NSFC 立项数据本身；所有结果由用户自行从公网获取。
- 数据准确性以 NSFC 官方为准；本项目不对结果做任何担保。

## 许可证

Apache-2.0。详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
