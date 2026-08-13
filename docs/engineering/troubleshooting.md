---
doc: engineering/troubleshooting.md
audience: RC 开发者、支持人员与排障 agent
status: 现行 · 2026-08-13
source-of-truth: 运行时实测、浏览器原生控件 A/B 与供应商公开资料
baseline: Research-Claw v0.8.2 · OpenClaw 2026.6.1
---

# Research-Claw 故障排查

## Dashboard 可连接，但文献/工作区/任务等同时为空或一直加载

### 先判定，不先迁移或清空数据

这组症状通常不是多套业务数据同时消失，而是 Gateway 进程存活、Dashboard 也能建立
WebSocket，但 `research-claw-core` 没有注册成功。典型伴随错误是
`unknown method: rc.review.candidates`。若文献、工作区、任务、监控、外设、作业同时
异常，必须先把它作为一个 **Core runtime 故障** 排查，不能逐个模块修复，更不能删除
SQLite、工作区或所谓“悬空数据”。

标准判定顺序：

1. 在实际项目目录运行 `pnpm health`。只有 HTTP、监听进程归属、Core 注册和全部启用
   服务的能力探针都通过，才算 healthy；`/healthz` 单独成功不构成验收。
2. 查看启动首屏。运行时必须为 Node 22.16+ 且 ABI 127；通过 `pnpm serve` 启动，
   不直接调用 `node ...openclaw...`。
3. 查看 `~/.research-claw/logs/run-latest.log`。`NODE_RUNTIME_UNSUPPORTED`、
   `NATIVE_ABI_MISMATCH`、`CORE_BUILD_MISSING` 会在业务服务启动前以退出码 78
   fail closed。
4. 在备份后只读核对 `~/.research-claw/library.db` 和配置中的 workspace 路径；记录
   关键表数量和工作区文件数，修复后使用相同口径复核。

### v0.8.1 / v0.8.2 同时出现的判读

一个打开很久的 Chrome 标签页可以继续运行旧 Dashboard bundle；与此同时端口上的
Gateway 已经来自新 checkout。于是浏览器角标、启动日志、Git HEAD 会给出不同版本。
这不是三个可互换的“本地版本”，而是三个不同身份层：

- **源码身份**：当前 checkout 的 `package.json` 与 Git commit；
- **服务身份**：真正占用 28789 的进程、cwd/打开的 config、Node/ABI、Core readiness；
- **页面身份**：当前标签页加载 bundle 时嵌入的 `RC_VERSION`。

Gateway 会拒绝版本不匹配的 Dashboard。看到提示后刷新该标签页，底部版本与连接状态
应恢复一致。不要用另一个目录中的 `git status` 或一个未刷新的页面角标推断当前服务
来源。`pnpm health` 会核对端口监听进程是否属于当前项目目录。

### 恢复、验收与回滚 SOP

1. 停止旧 Gateway，并确认 28789 没有其他监听者。
2. 对 SQLite 使用一致性备份（`sqlite3 DB ".backup 'BACKUP'"`），复制实际
   `config/openclaw.json`；记录 SQLite `PRAGMA integrity_check`、关键业务数量、workspace
   路径/文件数/Git HEAD。备份放在工作区之外。
3. 在目标 checkout 运行 `pnpm build && pnpm serve`。不要在 Node 24 下直接启动。
4. 运行 `pnpm health`；八个代表性 RPC 中，未启用的可选服务会明确 skipped，已启用
   服务缺 RPC 或有注册错误则失败。
5. 刷新现有 Dashboard 标签页，确认页脚版本、已连接状态，以及文献、工作区、论文
   评审、任务、监控、外设和可信审查均不是伪空状态；聊天向上滚动后应保持位置。
6. 用与第 2 步相同口径复核数据。若 DB 完整性或数量异常，先停止 Gateway，再从备份
   恢复；不要在服务打开 WAL 时直接覆盖数据库主文件。

风险控制：启动会运行 schema migration、作业协调和插件 sidecar，因此真实验收前必须
备份；能力探针仅使用 read-only RPC，不提交任务、不修改文献、不清理悬空引用。若只
想验证构建/native 契约而不启动服务，运行 `pnpm verify:runtime`。

## ToDesk 远控时，Chrome 中的搜狗拼音候选异常

### 结论

故障边界已定位到 **ToDesk × 搜狗输入法 for Mac × Chromium** 的原生文本输入
上下文，而不是 Dashboard 的 React 事件、受控输入框或键盘快捷键处理。冷启动或
刷新后的 Chrome 标签页可能出现两种症状：

- 搜狗不显示中文候选窗；
- 候选窗出现，但选中的中文没有提交给网页。

RC 通过在所有模块脚本之前加载 `text-input-context-warmup.js` 缓解该问题。脚本在
用户点击或聚焦原生 `textarea` 的捕获阶段，同步读取元素的值与选区；在已复现环境
中，这足以让第一次搜狗组合输入成功提交。工作假设是该读取促使 Chromium 同步了
原生文本输入上下文，但网页 JavaScript 无法观测或证实上游内部机制。默认路径不修改
文本、不取消事件，也不记录输入内容。

这是针对实测版本组合的兼容性缓解，不代表修复了 ToDesk、搜狗或 Chromium 的上游
缺陷。若预热失效，重新选择一次搜狗输入法，或切到 macOS 自带简体拼音后再切回搜狗。

### 证据等级与未知项

以下是网页侧能够直接证明的事实：

- 故障时 Chrome 能收到可信的键盘事件，曾记录到输入法常见的 `keyCode=229`；
- 随后的 `compositionstart`、`compositionupdate`、`beforeinput`、`input`、
  `compositionend` 提交链可能完全缺失，因此页面没有可补写的中文文本；
- 同一故障标签页中的无框架原生 `input` / `textarea` 也会失败；
- 同一设备上的 Safari、其他本机应用以及 Chrome 中的 macOS 自带简体拼音能够上屏；
- 重新选择一次搜狗，或先用系统拼音完成一次组合输入再切回搜狗，能够改变当前
  Chrome 标签页的后续表现；
- `v3` 预热在一次完整重启后的冷页面和紧接着的再次刷新中均通过了纯 ToDesk 验收。

据此可以高置信度判断：ToDesk 产生的按键已经到达 Chrome，但搜狗的组合文本没有
稳定穿过 macOS 输入法系统与 Chromium renderer 之间的原生提交桥。当前“冷文本输入
上下文 / 状态不同步”是最符合全部现象的工作假设。

以下内容**尚未得到证明**：

- 责任最终属于 ToDesk、搜狗、macOS InputMethodKit/TSM 还是 Chromium 的哪一个
  内部实现；
- 触发竞态的具体线程、函数或 Chromium 源码行；
- 读取 `value` / 选区究竟触发了哪一条 Chromium 内部同步路径；
- 该缓解对未实测的 macOS、Chrome、ToDesk、搜狗版本组合是否同样有效。

网页事件日志和公开源码只能界定故障发生在页面事件链之前，不能替代供应商原生调试
日志。因此文档和产品对外表述必须使用“兼容性缓解”，不能称为“已修复上游根因”。

### 已确认环境

| 组件 | 版本 |
|---|---|
| macOS | 26.5.2 |
| Chrome | 151.0.7922.71 |
| ToDesk | 4.8.8.9（build 1784） |
| 搜狗输入法 for Mac | 6.24.2.11682 |

### 事实矩阵

| 场景 | 结果 |
|---|---|
| 预热前：ToDesk → Chrome → RC 聊天框 → 搜狗拼音 | 冷页面中候选窗不出现，或候选词不能上屏 |
| 预热前：ToDesk → Chrome → 原生 `input` / `textarea` → 搜狗拼音 | 故障标签页中同样可能不能上屏 |
| 故障后重新选择“搜狗拼音” | 当前标签页恢复，刷新前可继续上屏 |
| 故障后切换 macOS 自带简体拼音，再切回搜狗 | 当前标签页恢复 |
| `v3` 预热：重启 Chrome 与 RC 后，全程 ToDesk 输入 `nihao` | 候选窗出现，`你好` 上屏 |
| `v3` 预热：再次刷新，不切输入法，全程 ToDesk 输入 `keyan` | 候选窗出现，中文上屏 |
| ToDesk → Safari / 其他本机应用 → 搜狗拼音 | 用户实测正常 |

诊断过程中还确认：切换一次输入法、在有效输入法下完成一次组合输入，或某些事件
监听实验会改变当前标签页的状态。因此验收必须从冷刷新开始，并且在测试前不能使用
本机键盘或先用 macOS 自带拼音输入。

### 实验记录与判读

按诊断顺序保留以下材料，避免后续把被污染的标签页误判为修复成功：

| 实验 | 观察 | 判读 |
|---|---|---|
| 冷刷新后直接在 RC 聊天框用 ToDesk + 搜狗输入 | 多次无法出现候选窗，或候选出现但无法提交 | 基线故障 |
| 只增加一个 `beforeinput` 监听器 | 未恢复 | 单事件监听不足 |
| 增加无日志、无弹窗的空监听器 | 未稳定恢复 | “存在监听器”本身不是充分条件 |
| 注入 capture/bubble 全事件矩阵后输入 | 某次恢复；清理监听器后当前标签页仍可继续输入 | 实验改变了标签页持久状态，不能把清理后的成功当作监听器仍在起效 |
| 新开 RC 标签页 | 新标签页仍失败 | 恢复状态至少具有标签页级特征 |
| 在页面插入蓝色原生 `textarea` | RC 原先仍失败；蓝框先成功输入后，RC 也恢复 | 原生控件上的一次有效文本会话可预热当前标签页 |
| 搜狗 → 搜狗重新选择 | 当前标签页恢复 | 输入法重选会重建或刷新相关状态 |
| 搜狗失败后切系统拼音输入，再切回搜狗 | 搜狗恢复 | 系统输入法的有效会话也会改变相关状态 |
| 故障标签页右侧打开其他 Chrome 页面/插件页 | 同样无法输入中文 | 现象并非 RC DOM 独有 |
| 早期产品化尝试构建后重启 | 多轮仍失败，或只出现候选窗不能上屏 | 早期方案已撤销，不能计入最终修复 |
| `v3`：重启服务和 Chrome，全程 ToDesk，输入 `nihao` | 候选窗出现，`你好` 上屏 | 第一轮冷启动通过 |
| `v3`：清空后再次刷新，不切输入法，继续纯 ToDesk 输入 | 候选窗出现，中文上屏 | 第二轮冷刷新通过 |

事件探针本身可能成为实验变量。任何打开 DevTools、注入控件、安装监听器、使用本机
键盘、切换输入法之后的成功，都不能替代上文规定的冷启动验收。

### 已排除项

以下改动不能建立 Chromium 的原生文本输入上下文，均已由真实 ToDesk 会话证伪：

- React 受控 → 非受控输入框；
- 把 `textarea` 移出 React、直接挂到 `document.body`；
- 删除元素级和 document 级键盘、composition、input 监听器；
- 修改 `width: 0`、flex、定位、边框等 CSS；
- 从初次创建起保持 enabled；
- 页面稳定后或用户点击时才创建输入框；
- 补 `beforeinput` 或空监听器。

不要通过合成 `composition*`、`beforeinput` 或 `input` 事件伪造中文提交。这些事件
不是可信的系统 IME 提交，既不能驱动搜狗候选窗，也容易破坏正常输入。

提交 `602db57` 曾尝试把聊天框改成浏览器持有值、在 composition/blur 边界回写 React
状态。原生控件 A/B 证明故障早于 React 后，该方案已由 `e2d5699` 完整撤销。最终
`e615517` 没有改变 `MessageInput` 的受控输入、发送、草稿或快捷键逻辑。

### 最终实现与无害性边界

`dashboard/index.html` 在主题脚本和 React 模块之前加载普通同步脚本
`/text-input-context-warmup.js?v=3`。默认模式只做以下事情：

1. 在 `window` capture 阶段监听 `pointerdown` 与 `focus`；
2. 目标是原生 `HTMLTextAreaElement` 时，同步读取 `value`、`selectionStart`、
   `selectionEnd`；
3. 对非 `textarea` 目标立即返回；
4. 不写值、不改选区、不聚焦、不创建 DOM、不合成事件、不调用 `preventDefault` 或
   `stopPropagation`，也不安装键盘/composition/input 监听器；
5. 不记录内容，不创建 `window.__rcImeProbe`。

这意味着正常键盘、鼠标、粘贴、系统拼音、Safari 以及 React 受控状态都仍由原有代码
处理。脚本只作用于当前文档中的原生 `textarea`；iframe、shadow DOM 内部控件和普通
`input` 不在当前缓解范围内。暂不扩大范围，因为只有 RC 聊天框的原生 `textarea`
路径完成了冷启动实机验收。

只有 URL 显式包含 `?ime-probe=full` 时才安装完整事件矩阵。诊断模式：

- 同时记录 capture/bubble 阶段的事件类型、`keyCode`、组合状态、`inputType`、
  `dataLength`、`valueLength` 和选区；
- 不记录 `key`、`data`、候选词或输入框内容；
- 只在内存中保留最近 200 条，并随页面卸载消失；
- 暴露 `window.__rcImeProbe.records` 供现场复制；
- 仍不取消、停止或合成任何事件。

长度和选区仍属于输入行为元数据，因此诊断模式只应用于复现页面，不应作为普通用户
的长期 URL。

### 用户侧恢复

若当前页面仍不能输入：

1. 从 macOS 输入法菜单重新选择一次“搜狗拼音”（搜狗 → 搜狗）。
2. 若仍未恢复，切到 macOS 自带“简体拼音”完成一次输入，再切回搜狗。
3. 临时改用 Safari，或在可输入的应用中完成长文本后粘贴。
4. 保持 ToDesk、Chrome 和搜狗为供应商稳定版；任一组件升级后重新执行下方验收。

### 开发者验收协议

验收前提：

1. 重启 RC 服务和 Chrome；
2. 预先选择搜狗拼音，此后不再切换输入法；
3. 从打开 RC 到完成测试，全程只使用 ToDesk 键鼠，不使用本机键盘；
4. 页面不带 `ime-probe` 参数，不打开 DevTools，不注入额外监听器。

验收至少执行两轮：

1. 冷刷新，确认聊天框为空且未聚焦，输入 `nihao` 并选择“你好”；
2. 清空草稿，再次刷新，不切输入法，输入 `keyan` 并选择中文；
3. 两轮均须同时满足“中文候选窗出现”和“候选词真正进入聊天框”。

若验收失败，可在 URL 添加 `?ime-probe=full`。该模式最多保留 200 条事件元数据，
包括事件类型、阶段、`keyCode`、组合状态、数据长度、值长度和选区；不保留按键文本、
候选文本或输入框内容。不要在普通用户会话中长期启用。

还可在 Console 创建一个不带框架和监听器的原生控件，用于判断故障是否已经扩展到
整个标签页：

```js
const probe = document.createElement('textarea');
Object.assign(probe.style, {
  position: 'fixed',
  zIndex: '999999',
  top: '12px',
  right: '12px',
  width: '360px',
  height: '90px',
  padding: '10px',
  background: 'white',
  color: 'black',
  border: '3px solid #3b82f6',
});
document.body.appendChild(probe);
probe.focus();
```

判定顺序：

1. 搜狗输入 `nihao`，确认候选窗是否出现、选词后 `probe.value` 是否变为 `你好`；
2. 不改变页面，只切换 macOS 自带简体拼音重复；
3. 若只有系统拼音成功，记录版本和 probe 元数据，按上游兼容回归处理；
4. 只有原生控件能提交而 RC 聊天框不能提交时，才进入 Dashboard 事件排查。

### 2026-07-31 验证记录

实现提交 `e615517` 及随后无害性复核的结果：

| 检查 | 结果 |
|---|---|
| `node --check public/text-input-context-warmup.js` | 通过 |
| 预热脚本专项 Vitest | 4/4 通过：加载顺序、只读行为、非 textarea 隔离、诊断字段/200 条上限 |
| 输入与 IME 针对性回归 | 11 个文件、116/116 通过 |
| Dashboard `pnpm build` | 通过；只有既有 chunk 大小与动态导入提示 |
| Dashboard 全量 Vitest（当前 main，含并行加入的 `50a1acd` LeftNav 测试） | 154/155 个文件、2300/2301 通过 |
| 全量测试唯一失败 | `PlaudCard.test.tsx` 的 popconfirm DOM 查询为空 |
| `PlaudCard.test.tsx` 正确使用 `--maxWorkers=1` 单独复跑 | 31/31 通过，确认是全量并发时序波动 |
| Chrome 默认模式 | 预热→主题→React 顺序正确；未启用 probe；点击、ASCII 输入和清空正常 |
| Chrome 诊断模式 | 启用标记正确；连续输入 40 字符不受阻；清空后恢复默认 URL |
| Chrome 验收收尾 | 默认 URL、聊天框为空、enabled、probe 标记不存在 |
| Chrome + RC 完整重启后的纯 ToDesk 冷启动 | 候选窗出现，`你好` 上屏 |
| 不切输入法的第二次冷刷新 | 候选窗出现，中文上屏 |

浏览器自动化使用隔离的只读页面上下文，可以读取共享 DOM 上的 probe 启用标记，但
不能直接读取主页面 realm 中的自定义 `window.__rcImeProbe`。因此“只保留 200 条、
不包含 `key` / `data` / `value`”由执行真实脚本的 Vitest 断言证明；浏览器验收只证明
诊断模式加载后不阻断正常输入。不得把两种证据混写。

全量并发测试第一次运行并非全部绿色，失败项也不得省略；该失败在正确的单文件串行
复跑中转绿。专项测试、针对性输入回归、生产构建、默认/诊断浏览器检查和本问题的
两轮纯 ToDesk 实机验收共同构成当前接受该缓解的依据。

### 回滚与后续复核

- 若发现 textarea 点击、聚焦、选区、粘贴、系统输入法或无障碍工具行为回归，删除
  `index.html` 中的预热脚本引用即可完整停止该缓解；聊天框 React 逻辑无需回滚。
- Chrome、ToDesk、搜狗或 macOS 任一项升级后，先按冷启动协议做“有预热/无预热”
  A/B。只有无预热也连续通过时，才考虑移除兼容代码。
- 若要追求源码级根因，需要供应商或带符号的 Chromium/macOS 原生日志，重点核对
  Sogou 提交调用、Chromium `ImeCommitText` 接收以及 renderer ACK 的先后关系。

### 公开依据

- [ToDesk 官方论坛：搜狗在 Chrome/Chromium 应用异常，而系统拼音不受影响的相似案例](https://bbs.todesk.com/forum.php?mod=viewthread&tid=1622)
- [ToDesk 官方：macOS 被控端需要辅助功能等权限](https://www.todesk.com/helpcenter/solo-69.html)
- [ToDesk 官方：当前公开的键盘设置仅描述跨系统按键映射](https://www.todesk.com/helpcenter/solo-281.html)
- [搜狗输入法 for Mac 官方更新日志](https://pinyin.sogou.com/mac/update_log.php)
- [Chromium macOS 输入实现：`ImeCommitText` 与同步 IME / 异步渲染桥接](https://chromium.googlesource.com/chromium/src/+/126ae9c7fa7eb8331235b9467031c2dcdaaf30f0/content/app_shim_remote_cocoa/render_widget_host_view_cocoa.mm)
