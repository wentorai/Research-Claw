#!/usr/bin/env node
/**
 * F7 真机验收用的**假模型服务端** —— 确定性、离线、零凭据、零成本。
 *
 * 为什么需要它:F7 验的是 OpenClaw 的**投递腿**(cron agentTurn 的最终回复文本能不能
 * 送到渠道),模型本身不在被测范围。真实模型有网络、有费用、有不确定性,还得带凭据,
 * 三条都跟"隔离验收"冲突。所以这里起一个本地假模型:回复内容由一个文本文件决定,
 * 想验空回复就把文件清空,想验非空就写进去。
 *
 * 协议形态(从 OC 源码实证,不是猜的):
 *   node_modules/openclaw/dist/openai-completions-Bn1F8OS2.js
 *     - buildParams() 硬编码 `stream: true`(:693),openai-completions 这条路**只有流式**
 *     - createClient() 用官方 `openai` SDK,baseURL = provider.baseUrl,SDK 自己拼
 *       `/chat/completions`,所以 baseUrl 要带 `/v1`
 *     - 消费循环末尾 `if (!hasFinishReason) throw new Error("Stream ended without finish_reason")`
 *       → 必须有一个带 choices[0].finish_reason 的 chunk,否则整轮判错
 *     - `if (choice.delta.content ... .length > 0)` → 空串 delta 会被跳过,
 *       正好等价于"助手回复为空",这是空回复用例要的语义
 *
 * 行为约定:
 *   - 监听 127.0.0.1:18901
 *   - **每次请求**读一次 FAKE_MODEL_REPLY_FILE(默认 /tmp/rc-f7-fake-reply.txt),
 *     不缓存 —— 同一个进程内可以在两个用例之间改文件切换回复
 *   - 文件不存在 / 内容空白 → 回复文本为空串
 *   - 永不发起工具调用,永远单个 text delta + finish_reason="stop"
 *   - 每请求往 /tmp/rc-f7-fake-model.log 追加一行(时间戳/路径/回复长度)。
 *     **刻意不记请求体**:system prompt 有两万字符,记下来日志没法看。
 *
 * 用法:
 *   node scripts/f7-fake-model.mjs &
 *   printf 'hello from fake model' > /tmp/rc-f7-fake-reply.txt
 */

import http from "node:http";
import fs from "node:fs";

const HOST = process.env.FAKE_MODEL_HOST ?? "127.0.0.1";
const PORT = Number(process.env.FAKE_MODEL_PORT ?? 18901);
const REPLY_FILE = process.env.FAKE_MODEL_REPLY_FILE ?? "/tmp/rc-f7-fake-reply.txt";
const LOG_FILE = process.env.FAKE_MODEL_LOG_FILE ?? "/tmp/rc-f7-fake-model.log";

/** 请求时刻读盘。读失败/空白一律当空回复,绝不抛出 —— 假模型挂掉会被误读成产品缺陷。 */
function readReply() {
  let raw;
  try {
    raw = fs.readFileSync(REPLY_FILE, "utf8");
  } catch {
    return "";
  }
  return raw.trim().length === 0 ? "" : raw;
}

function logLine(pathname, replyLength, note = "") {
  const line = `${new Date().toISOString()} ${pathname} replyLength=${replyLength}${note ? ` ${note}` : ""}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    /* 日志写不进去不该影响用例 */
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** OpenAI chat.completions 流式分片。 */
function chunkFrame(id, model, created, choice, usage) {
  const body = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, ...choice }],
    ...(usage ? { usage } : {}),
  };
  return `data: ${JSON.stringify(body)}\n\n`;
}

function respondStream(res, pathname, modelId) {
  const reply = readReply();
  logLine(pathname, reply.length, "stream");

  const id = `chatcmpl-f7-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  // 1) role 起手分片
  res.write(chunkFrame(id, modelId, created, { delta: { role: "assistant", content: "" }, finish_reason: null }));
  // 2) 正文分片 —— 空回复时刻意不发(OC 消费端对空串 delta 本来就跳过)
  if (reply.length > 0) {
    res.write(chunkFrame(id, modelId, created, { delta: { content: reply }, finish_reason: null }));
  }
  // 3) 收尾分片:finish_reason 必须有,否则 OC 抛 "Stream ended without finish_reason"
  res.write(
    chunkFrame(
      id,
      modelId,
      created,
      { delta: {}, finish_reason: "stop" },
      { prompt_tokens: 1, completion_tokens: reply.length > 0 ? 1 : 0, total_tokens: 1 },
    ),
  );
  res.write("data: [DONE]\n\n");
  res.end();
}

/** 非流式兜底:少数探针(健康检查/onboard 探测)不带 stream,给一个等价响应。 */
function respondJson(res, pathname, modelId) {
  const reply = readReply();
  logLine(pathname, reply.length, "non-stream");
  sendJson(res, 200, {
    id: `chatcmpl-f7-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: reply.length > 0 ? 1 : 0, total_tokens: 1 },
  });
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

  if (req.method === "POST" && pathname.endsWith("/chat/completions")) {
    // 只嗅前 8KB:够拿到 "model" / "stream" 两个字段(OC 把它们放在 params 开头),
    // 后面几万字符的 system prompt 直接丢掉,不进内存也不进日志。
    const head = [];
    let sniffed = 0;
    req.on("data", (chunk) => {
      if (sniffed < 8192) {
        head.push(chunk);
        sniffed += chunk.length;
      }
    });
    req.on("end", () => {
      const body = Buffer.concat(head).toString("utf8");
      const modelId = /"model"\s*:\s*"([^"]+)"/.exec(body)?.[1] ?? "fake-echo";
      if (/"stream"\s*:\s*true/.test(body)) respondStream(res, pathname, modelId);
      else respondJson(res, pathname, modelId);
    });
    req.on("error", () => {
      if (!res.headersSent) respondStream(res, pathname, "fake-echo");
    });
    return;
  }

  if (req.method === "GET" && pathname.endsWith("/models")) {
    logLine(pathname, 0, "models-list");
    sendJson(res, 200, {
      object: "list",
      data: [{ id: "fake-echo", object: "model", created: 0, owned_by: "rc-f7" }],
    });
    return;
  }

  req.resume();
  logLine(pathname, 0, `unhandled method=${req.method}`);
  sendJson(res, 404, { error: { message: `unhandled ${req.method} ${pathname}`, type: "invalid_request_error" } });
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`f7-fake-model listening on http://${HOST}:${PORT}  replyFile=${REPLY_FILE}  log=${LOG_FILE}\n`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
