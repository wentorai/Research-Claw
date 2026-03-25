---
name: multi-search-engine
description: Integration of 17 search engines for web crawling without API keys. Includes 8 domestic (Baidu, Bing CN, 360, Sogou, WeChat, Toutiao, Jisilu) and 9 international engines (Google, DuckDuckGo, Yahoo, Startpage, Brave, Ecosia, Qwant, WolframAlpha).
tags: [search, web, multi-engine, crawler]
version: 1.0.0
author: gpyangyoujun
source: https://clawhub.ai/gpyangyoujun/multi-search-engine
---

# Multi Search Engine

Integration of 17 search engines for web crawling without API keys.

---

## Search Engines

### Domestic (8)

| Engine | URL Template |
|--------|-------------|
| Baidu | `https://www.baidu.com/s?wd={keyword}` |
| Bing CN | `https://cn.bing.com/search?q={keyword}&ensearch=0` |
| Bing INT | `https://cn.bing.com/search?q={keyword}&ensearch=1` |
| 360 | `https://www.so.com/s?q={keyword}` |
| Sogou | `https://sogou.com/web?query={keyword}` |
| WeChat | `https://wx.sogou.com/weixin?type=2&query={keyword}` |
| Toutiao | `https://so.toutiao.com/search?keyword={keyword}` |
| Jisilu | `https://www.jisilu.cn/explore/?keyword={keyword}` |

### International (9)

| Engine | URL Template |
|--------|-------------|
| Google | `https://www.google.com/search?q={keyword}` |
| Google HK | `https://www.google.com.hk/search?q={keyword}` |
| DuckDuckGo | `https://duckduckgo.com/html/?q={keyword}` |
| Yahoo | `https://search.yahoo.com/search?p={keyword}` |
| Startpage | `https://www.startpage.com/sp/search?query={keyword}` |
| Brave | `https://search.brave.com/search?q={keyword}` |
| Ecosia | `https://www.ecosia.org/search?q={keyword}` |
| Qwant | `https://www.qwant.com/?q={keyword}` |
| WolframAlpha | `https://www.wolframalpha.com/input?i={keyword}` |

---

## Quick Examples

### Basic Search

```javascript
web_fetch({"url": "https://www.google.com/search?q=python+tutorial"})
```

### Site-Specific

```javascript
web_fetch({"url": "https://www.google.com/search?q=site:github.com+react"})
```

### File Type

```javascript
web_fetch({"url": "https://www.google.com/search?q=machine+learning+filetype:pdf"})
```

### Time Filter (Past Week)

```javascript
web_fetch({"url": "https://www.google.com/search?q=ai+news&tbs=qdr:w"})
```

### Privacy Search

```javascript
web_fetch({"url": "https://duckduckgo.com/html/?q=privacy+tools"})
```

### DuckDuckGo Bangs

```javascript
web_fetch({"url": "https://duckduckgo.com/html/?q=!gh+tensorflow"})
```

### Knowledge Calculation

```javascript
web_fetch({"url": "https://www.wolframalpha.com/input?i=100+USD+to+CNY"})
```

---

## Advanced Operators

| Operator | Example | Description |
|----------|---------|-------------|
| `site:` | `site:github.com python` | Search within site |
| `filetype:` | `filetype:pdf report` | Specific file type |
| `""` | `"machine learning"` | Exact match |
| `-` | `python -snake` | Exclude term |
| `OR` | `cat OR dog` | Either term |

---

## Time Filters

| Parameter | Description |
|-----------|-------------|
| `tbs=qdr:h` | Past hour |
| `tbs=qdr:d` | Past day |
| `tbs=qdr:w` | Past week |
| `tbs=qdr:m` | Past month |
| `tbs=qdr:y` | Past year |

---

## Privacy Engines

Use these engines when privacy is a concern:

| Engine | Feature |
|--------|---------|
| DuckDuckGo | No tracking |
| Startpage | Google results + privacy |
| Brave | Independent index |
| Qwant | EU GDPR compliant |

---

## Bangs Shortcuts (DuckDuckGo)

DuckDuckGo Bangs allow instant redirection to other sites:

| Bang | Destination |
|------|-------------|
| `!g` | Google |
| `!gh` | GitHub |
| `!so` | Stack Overflow |
| `!w` | Wikipedia |
| `!yt` | YouTube |

Example:
```javascript
web_fetch({"url": "https://duckduckgo.com/html/?q=!gh+tensorflow"})
```

---

## WolframAlpha Queries

WolframAlpha is a computational knowledge engine:

| Query Type | Example |
|------------|---------|
| Math | `integrate x^2 dx` |
| Conversion | `100 USD to CNY` |
| Stocks | `AAPL stock` |
| Weather | `weather in Beijing` |

---

## When to Use This Skill

- User needs to search multiple engines
- API key is not available
- Privacy-focused search is needed
- Chinese domestic content search
- Computational/knowledge queries (WolframAlpha)
- Site-specific or file-type searches

---

## Recommended Usage

1. **Default**: Use DuckDuckGo or Brave for privacy
2. **Chinese content**: Use Baidu or Bing CN
3. **Academic/PDF**: Use Google with `filetype:pdf`
4. **Computations**: Use WolframAlpha
5. **Code search**: Use DuckDuckGo bangs (`!gh`, `!so`)

---

## License

MIT
