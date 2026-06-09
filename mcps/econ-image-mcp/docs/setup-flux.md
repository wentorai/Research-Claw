# FLUX.1 配置（推荐先用 Replicate / fal.ai）

FLUX.1 是 Black Forest Labs 出品的强力开源图像模型，跑同一 prompt 通常比 DALL-E 3 便宜 5–10 倍，且对 infographic / 矢量风格友好。

## 1. 选 gateway

| Gateway | 注册地址 | 环境变量 |
|---|---|---|
| Replicate | https://replicate.com/black-forest-labs | `REPLICATE_API_TOKEN` |
| fal.ai | https://fal.ai/models/fal-ai/flux | `FAL_KEY` |
| Black Forest Labs 官方 | https://api.bfl.ml | `BFL_API_KEY` |

任选其一即可。`econ-image-mcp` 默认看到任何一个都会把 `is_available()` 设为 `True`。

## 2. 配置环境变量

```bash
export REPLICATE_API_TOKEN="rpl_xxxxxxxxxxxxxxxx"
# 或
export FAL_KEY="..."
# 或
export BFL_API_KEY="..."
```

## 3. 实现 generate()

`src/econ_image_mcp/providers/flux.py` 当前是 skeleton。补全 `generate()` 即可，参考如下 Replicate 调用形态：

```python
async with httpx.AsyncClient(timeout=self._timeout) as client:
    r = await client.post(
        "https://api.replicate.com/v1/predictions",
        headers={"Authorization": f"Token {self._replicate_token}"},
        json={
            "version": "<flux-schnell-or-dev-version-hash>",
            "input": {"prompt": prompt, "aspect_ratio": "16:9"},
        },
    )
```

Replicate 是异步任务，需要轮询 `prediction["urls"]["get"]` 直到 `status == "succeeded"`，再读取 `output[0]` 的 URL。

## 4. 中国大陆访问

Replicate / fal.ai 在国内访问偶有抖动，建议挂代理或走自建 mirror。
