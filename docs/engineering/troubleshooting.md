---
doc: engineering/troubleshooting.md
audience: RC 开发者、支持人员与排障 agent
status: 现行 · 2026-07-31
source-of-truth: 运行时实测、浏览器原生控件 A/B 与供应商公开资料
baseline: Research-Claw v0.8.1 · OpenClaw 2026.6.1
---

# Research-Claw 故障排查

## ToDesk 远控时，Chrome 中的搜狗拼音候选词无法上屏

### 结论

这是 **ToDesk × 搜狗输入法 for Mac × Chromium** 的候选提交兼容问题，不是
Dashboard 的 React 事件、受控输入框或键盘快捷键处理问题。

在已复现环境中，搜狗能显示候选窗，但选中的中文没有通过 macOS 文本输入接口提交
给 Chrome。网页收不到目标文本，也就无法在 `beforeinput`、`input` 或
`compositionend` 中补救。macOS 自带简体拼音在同一 Chrome 标签页、同一原生
`textarea` 中可以正常上屏。

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
| ToDesk → Chrome → RC 聊天框 → 搜狗拼音 | 候选窗出现，候选词不能上屏 |
| ToDesk → Chrome → `document.body` 原生 `textarea` → 搜狗拼音 | 同样不能上屏 |
| 上述原生控件去掉 React、事件监听、CSS、禁用态，并在真实点击后延迟创建 | 同样不能上屏 |
| ToDesk → 同一 Chrome 标签页、同一原生控件 → macOS 自带简体拼音 | 正常上屏 |
| ToDesk → Safari / 其他本机应用 → 搜狗拼音 | 用户实测正常 |

曾有一次在 DevTools Console 注入事件采集器和原生输入框后，当前标签页被“预热”
并可输入中文；清理监听器后仍保持，刷新后也保持，但新标签页不保持。后续在不打开
DevTools 的同构实验中无法复现，因此它只能证明 Chrome 标签页的 IME 状态可被外部
操作改变，不能作为产品修复。

### 已排除项

不要再通过以下改动尝试修复该组合；它们均已由真实 ToDesk 会话证伪：

- React 受控 → 非受控输入框；
- 把 `textarea` 移出 React、直接挂到 `document.body`；
- 删除元素级和 document 级键盘、composition、input 监听器；
- 修改 `width: 0`、flex、定位、边框等 CSS；
- 从初次创建起保持 enabled；
- 页面稳定后或用户点击时才创建输入框；
- 补 `beforeinput` 或空监听器。

### 用户侧处理

1. **稳定方案：**远控 Chrome 时切换到 macOS 自带“简体拼音”。
2. **替代方案：**必须使用搜狗时，改用 Safari；长文本也可在可输入的应用中完成后粘贴。
3. 保持 ToDesk、Chrome 和搜狗为供应商稳定版；升级后用本文的原生控件 A/B 重新验收。
4. 向 ToDesk 与搜狗提交兼容性反馈时，附上四项版本、复现步骤，以及“候选窗出现但
   原生 `textarea` 收不到提交文本；系统拼音正常”这一关键判据。

不要把“切换系统拼音”包装为 RC 已修复搜狗兼容性。供应商修复前，正确状态是
“已定位外部兼容缺陷，并提供稳定规避方案”。

### 开发者验收协议

在 Console 创建一个不带框架和监听器的原生控件：

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
3. 若只有系统拼音成功，停止修改 Dashboard，按供应商兼容问题处理；
4. 只有原生控件能提交而 RC 聊天框不能提交时，才进入 Dashboard 的 IME 事件排查。

### 公开依据

- [ToDesk 官方论坛：搜狗在 Chrome/Chromium 应用异常，而系统拼音不受影响的相似案例](https://bbs.todesk.com/forum.php?mod=viewthread&tid=1622)
- [ToDesk 官方：macOS 被控端需要辅助功能等权限](https://www.todesk.com/helpcenter/solo-69.html)
- [ToDesk 官方：当前公开的键盘设置仅描述跨系统按键映射](https://www.todesk.com/helpcenter/solo-281.html)
- [搜狗输入法 for Mac 官方更新日志](https://pinyin.sogou.com/mac/update_log.php)
- [Chromium macOS 输入实现：`ImeCommitText` 与同步 IME / 异步渲染桥接](https://chromium.googlesource.com/chromium/src/+/126ae9c7fa7eb8331235b9467031c2dcdaaf30f0/content/app_shim_remote_cocoa/render_widget_host_view_cocoa.mm)
