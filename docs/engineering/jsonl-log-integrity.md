# JSONL 日志完整性与诊断容错

## 2026-08-13 事故结论

`~/.research-claw/logs/openclaw.log` 中发现两条 malformed JSONL，分别对应
11:15:10 与 11:48:48 两次网关启动时的 Weixin provider 启动消息。两条损坏记录：

- 长度均为 972 bytes；
- 均在 byte 151 出现一个 Unicode `…`；
- 前后 JSON 片段完整，下一行也完整；
- 在相同输入上可由 OpenClaw `redactSensitiveText()` 确定性复现。

因此排除多进程 append 交错与文件尾截断。根因是 file logger 先对 record 做结构化
`redactSecrets()`，随后又对 `JSON.stringify(record)` 的整行做文本正则脱敏。正则把
`_meta.runtime` 开始、直到 pnpm 路径中 `token` 字样附近的跨字段文本误判为 secret，
用中段掩码替换后破坏了 JSON 语法。

## 修复边界

- file logger 只序列化已经结构化脱敏的 record，不再对 JSON 语法执行第二次文本替换；
- 字段级 token/apiKey 等脱敏继续保留；
- 诊断工具以 JSONL 逐行解析，单行失败不会中止或吞掉后续记录；
- malformed 原文经过文本脱敏后包装为合法 `_rc_diag.malformed` 记录；
- bundle 的 `MANIFEST.txt` 和终端同时报告 `malformed_count`。

历史日志不在原地修写，避免诊断行为修改证据。新写入日志由补丁保证结构完整；旧损坏行
由诊断包容错保留。
