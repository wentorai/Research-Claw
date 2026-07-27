#!/usr/bin/env node
/**
 * F7 三路投递验收用的**极简 IRC 旁听端**。
 *
 * 为什么需要它:F7 的最后一段是"消息到底有没有真的发出去"。gateway 的 run 记录里
 * 有 delivered / deliveryAttempted 字段,但那是 OC 自己的自述 —— 用它当唯一证据,
 * 等于让被测系统给自己打分。旁听端是**独立第三方**:它以普通用户身份坐在同一个
 * IRC 频道里,把收到的每条 PRIVMSG 落盘。有 token 出现 = 真送达;没有 = 真没送。
 *
 * 刻意零依赖(裸 TCP,不引 irc 库):harness 的依赖越少,失败越不可能是 harness 的错。
 *
 * 用法:
 *   node scripts/f7-irc-observer.mjs            # 默认 127.0.0.1:16668 / #rc-f7
 *   F7_IRC_PORT=16667 node scripts/f7-irc-observer.mjs
 *
 * 产物(默认 /tmp/rc-f7-irc-observed.log),每行一条:
 *   2026-07-25T…Z <nick> #rc-f7 :<正文>
 * 就绪后额外打一行 `READY` 到 stdout,调用方可据此等待加入完成。
 */

import net from "node:net";
import fs from "node:fs";

const HOST = process.env.F7_IRC_HOST ?? "127.0.0.1";
const PORT = Number(process.env.F7_IRC_PORT ?? 16668);
const CHANNEL = process.env.F7_IRC_CHANNEL ?? "#rc-f7";
const NICK = process.env.F7_IRC_NICK ?? "f7observer";
const LOG_FILE = process.env.F7_IRC_LOG ?? "/tmp/rc-f7-irc-observed.log";

fs.writeFileSync(LOG_FILE, "");

const sock = net.createConnection({ host: HOST, port: PORT });
sock.setEncoding("utf8");

const send = (line) => sock.write(`${line}\r\n`);

sock.on("connect", () => {
  send(`NICK ${NICK}`);
  send(`USER ${NICK} 0 * :F7 delivery observer`);
});

let buffer = "";
let joined = false;

sock.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).replace(/\r$/, "");
    buffer = buffer.slice(idx + 1);
    if (!line) continue;

    // 服务端心跳:不回 PONG 会在几十秒后被踢,静默丢消息。
    if (line.startsWith("PING ")) {
      send(`PONG ${line.slice(5)}`);
      continue;
    }

    // 001 = RPL_WELCOME,注册完成才能 JOIN。
    if (/^:\S+ 001 /.test(line) && !joined) {
      joined = true;
      send(`JOIN ${CHANNEL}`);
      continue;
    }

    // 自己的 JOIN 回执 → 真正就位。
    if (!process.env.__F7_READY && new RegExp(`^:${NICK}!\\S+ JOIN`, "i").test(line)) {
      process.env.__F7_READY = "1";
      process.stdout.write("READY\n");
      continue;
    }

    const m = /^:([^!\s]+)\S* PRIVMSG (\S+) :(.*)$/.exec(line);
    if (m) {
      fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} <${m[1]}> ${m[2]} :${m[3]}\n`);
    }
  }
});

sock.on("error", (err) => {
  process.stderr.write(`f7-irc-observer error: ${err.message}\n`);
  process.exit(1);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    try {
      send("QUIT :bye");
    } catch { /* 连接已断就算了 */ }
    sock.end();
    process.exit(0);
  });
}
