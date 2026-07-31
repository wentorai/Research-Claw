---
doc: engineering/troubleshooting.md
audience: RC 开发者、支持人员与排障 agent
status: 现行 · 2026-07-31
source-of-truth: 运行时实测、浏览器原生控件 A/B 与供应商公开资料
baseline: Research-Claw v0.8.1 · OpenClaw 2026.6.1
---

# Research-Claw 故障排查

## ToDesk 远控时，Chrome 中的搜狗拼音候选异常

### 结论

根因位于 **ToDesk × 搜狗输入法 for Mac × Chromium** 的原生文本输入上下文，
不是 Dashboard 的 React 事件、受控输入框或键盘快捷键处理。冷启动或刷新后的
Chrome 标签页可能出现两种症状：

- 搜狗不显示中文候选窗；
- 候选窗出现，但选中的中文没有提交给网页。

RC 通过在所有模块脚本之前加载 `text-input-context-warmup.js` 缓解该问题。脚本在
用户点击或聚焦原生 `textarea` 的捕获阶段，同步读取元素的值与选区；在已复现环境
中，这足以让第一次搜狗组合输入成功提交。工作假设是该读取促使 Chromium 同步了
原生文本输入上下文，但网页 JavaScript 无法观测或证实上游内部机制。默认路径不修改
文本、不取消事件，也不记录输入内容。

这是针对实测版本组合的兼容性缓解，不代表修复了 ToDesk、搜狗或 Chromium 的上游
缺陷。若预热失效，重新选择一次搜狗输入法，或切到 macOS 自带简体拼音后再切回搜狗。

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

### 公开依据

- [ToDesk 官方论坛：搜狗在 Chrome/Chromium 应用异常，而系统拼音不受影响的相似案例](https://bbs.todesk.com/forum.php?mod=viewthread&tid=1622)
- [ToDesk 官方：macOS 被控端需要辅助功能等权限](https://www.todesk.com/helpcenter/solo-69.html)
- [ToDesk 官方：当前公开的键盘设置仅描述跨系统按键映射](https://www.todesk.com/helpcenter/solo-281.html)
- [搜狗输入法 for Mac 官方更新日志](https://pinyin.sogou.com/mac/update_log.php)
- [Chromium macOS 输入实现：`ImeCommitText` 与同步 IME / 异步渲染桥接](https://chromium.googlesource.com/chromium/src/+/126ae9c7fa7eb8331235b9467031c2dcdaaf30f0/content/app_shim_remote_cocoa/render_widget_host_view_cocoa.mm)
