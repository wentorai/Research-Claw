# Ideogram v2 配置（推荐做海报 / 政策简报封面）

Ideogram 的强项是**排版和文字渲染**，特别适合：
- 海报标题 + 副标题排版
- 政策简报封面
- 含中英文 label 的 Graphical Abstract

## 1. 通过 Replicate（最简单）

1. 注册 https://replicate.com，绑定信用卡。
2. 拿到 token：`https://replicate.com/account/api-tokens`。

```bash
export REPLICATE_API_TOKEN="rpl_xxxxxxxxxxxxxxxx"
```

3. 找到当前 Ideogram v2 的 version hash：
   - 打开 https://replicate.com/ideogram-ai/ideogram-v2
   - 复制最新 model version 的 64-char hex hash

## 2. 实现 generate()

`src/econ_image_mcp/providers/ideogram.py` 当前是 skeleton。建议接口：

```python
async with httpx.AsyncClient(timeout=120) as client:
    r = await client.post(
        "https://api.replicate.com/v1/predictions",
        headers={"Authorization": f"Token {self._replicate_token}"},
        json={
            "version": IDEOGRAM_V2_VERSION,
            "input": {
                "prompt": prompt,
                "aspect_ratio": "16:9",
                "magic_prompt_option": "Auto",
                "style_type": style or "AUTO",
            },
        },
    )
    pred = r.json()
    # 轮询 pred["urls"]["get"] 直到 status == "succeeded"
```

## 3. 中文 prompt

Ideogram v2 对中英混排 prompt 友好；写海报标题时直接写：
```
Poster with title text "数字经济与共同富裕", 学术海报, 16:9.
```
通常能直接出来一张可读的版本。
