# DALL-E 3 配置（已实现，开箱即用）

`econ-image-mcp` 里 DALL-E 3 是**唯一一个完整实现**的真实 provider，配好 key 就能用。

## 1. 拿一把 OpenAI API key

去 https://platform.openai.com/api-keys 创建一把 `sk-...` 开头的 key。

> DALL-E 3 是按图收费的（HD 1024×1024 ≈ $0.080/张，1024×1792 / 1792×1024 ≈ $0.120/张），跑前留意预算。

## 2. 配置环境变量

```bash
export OPENAI_API_KEY="sk-xxxxxxxxxxxxxxxxxxxx"
```

或写到 `examples/claude_desktop_config.json` 的 `env` 块里。

## 3. 验证

```bash
python -c "
import asyncio
from econ_image_mcp.providers.dalle import DalleProvider

async def main():
    p = DalleProvider()
    print('available:', await p.is_available())
    res = await p.generate(
        'Schematic of monetary policy transmission, infographic style, blue palette',
        size='1792x1024',
    )
    print(res)

asyncio.run(main())
"
```

看到一行 `ImageResult(provider='dalle', url='https://...', ...)` 就算通了。

## 4. 支持的 size

DALL-E 3 仅支持：
- `1024x1024` （正方形，最便宜）
- `1024x1792` （竖版海报、Graphical Abstract）
- `1792x1024` （横版机制图、宣传图）

其它尺寸会被 provider 显式拒绝（`ProviderAPIError`）。

## 5. 限速

OpenAI 对 DALL-E 3 默认 5 RPM，组织升 Tier 后可放宽。`econ-image-mcp` 当前不做客户端节流，需要自行 sleep 或上 cache。

## 6. 安全 / 合规

OpenAI 的 safety system 会自动改写或拒绝某些 prompt。被改写后真正用于生成的 prompt 在响应里以 `revised_prompt` 字段返回，`econ-image-mcp` 已经把它暴露在 `ImageResult.revised_prompt` 上。
