# Imagen 3 配置（GCP / Vertex AI）

Google Imagen 3 通过 Vertex AI 暴露，需要一个 GCP 项目 + 启用 Vertex AI + 服务账号。

## 1. GCP 项目准备

1. 登录 https://console.cloud.google.com，创建或选定一个项目。
2. 启用 Vertex AI API（搜索 “Vertex AI API”，点 “Enable”）。
3. 选一个支持 Imagen 3 的 region，例如 `us-central1`。

## 2. 创建服务账号

```bash
gcloud iam service-accounts create econ-image \
    --display-name "econ-image-mcp"

gcloud projects add-iam-policy-binding $PROJECT \
    --member "serviceAccount:econ-image@$PROJECT.iam.gserviceaccount.com" \
    --role "roles/aiplatform.user"

gcloud iam service-accounts keys create sa.json \
    --iam-account econ-image@$PROJECT.iam.gserviceaccount.com
```

## 3. 配置环境变量

```bash
export GOOGLE_CLOUD_PROJECT="your-project-id"
export GOOGLE_CLOUD_REGION="us-central1"
export GOOGLE_APPLICATION_CREDENTIALS="/abs/path/to/sa.json"
```

三个变量必须**同时**存在，`is_available()` 才会返回 `True`。

## 4. 实现 generate()

`src/econ_image_mcp/providers/imagen.py` 当前是 skeleton。Vertex AI 的 endpoint 形如：

```
POST https://{REGION}-aiplatform.googleapis.com/v1/projects/{PROJECT}/locations/{REGION}/publishers/google/models/imagen-3.0-generate-001:predict
```

请求体大致：
```json
{
  "instances": [{"prompt": "..."}],
  "parameters": {"sampleCount": 1, "aspectRatio": "16:9"}
}
```

OAuth2 token 推荐用 `google-auth` 包获取（`google.auth.default()` → `request.refresh()` → `credentials.token`）。

## 5. 计费

Imagen 3 标准模型 ~$0.04/张（fast），imagen-3.0 ~$0.08/张。注意 GCP 配额需要先申请提升，否则可能 throttling。
