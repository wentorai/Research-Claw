# Recraft v3 配置（推荐做政策机制图 / Graphical Abstract）

Recraft v3 的强项是**矢量 / infographic 风格**，最适合：
- 政策传导机制图
- 概念示意图（信息不对称、网络效应、风险传染）
- Graphical Abstract
- 教科书风插图

它是 Replicate 上 economics/management 论文 figure 1 的最佳一档之一。

## 1. 拿 token

两种 gateway，二选一：

| Gateway | 注册 | 环境变量 |
|---|---|---|
| Replicate | https://replicate.com/recraft-ai | `REPLICATE_API_TOKEN` |
| Recraft 官方 | https://www.recraft.ai/api | `RECRAFT_API_KEY` |

```bash
export REPLICATE_API_TOKEN="rpl_xxxxxxxxxxxxxxxx"
# 或
export RECRAFT_API_KEY="rk_xxxxxxxxxxxxxxxx"
```

## 2. version hash

打开 https://replicate.com/recraft-ai/recraft-v3，复制最新 model version 的 64-char hex hash。

## 3. 实现 generate()

`src/econ_image_mcp/providers/recraft.py` 当前是 skeleton。Recraft v3 的关键 input 字段：

```python
{
    "prompt": prompt,
    "size": "1024x1024",  # or 1365x1024 etc
    "style": style or "vector_illustration",  # 或 "digital_illustration", "realistic_image"
}
```

## 4. 风格选择对照

| 论文场景 | 推荐 style |
|---|---|
| 机制图 / 流程图 | `vector_illustration` |
| Graphical Abstract | `digital_illustration` |
| 概念图（教科书风） | `vector_illustration` |
| 政策简报封面 | `realistic_image` |
| 海报背景 | `vector_illustration` 或 `realistic_image` |

## 5. 计费

Replicate 上 Recraft v3 ≈ $0.04/张，比 DALL-E 3 便宜约一半。
