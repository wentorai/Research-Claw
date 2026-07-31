# 聊天证据与交付卡片：本地手工验收

适用分支：`codex/rc-chat-card-reliability`。本清单只做本地验收，不 push、
不发布，也不修改 Wentor 外层仓库 gitlink。

## 1. 启动

确认本机 Node 是 22，且 28789/5175 没有另一套 RC 占用，然后执行：

```bash
cd /Users/liusiyuan/Downloads/wentor/research-claw-worktrees/chat-card-reliability
node --version
pnpm install --frozen-lockfile
pnpm build
pnpm dev
```

打开 `http://127.0.0.1:5175`。已有本地配置、模型和 Research-Plugins 应由
RC 启动链读取；不要为验收把密钥写入仓库。

## 2. 真实模型主闭环

在一个新会话 A 发送以下要求（主题可替换，但必须保留最后一句）：

> 请调用 search_openalex 检索 quantum computing，limit=5；再调用
> workspace_save 把简短检索说明保存到
> outputs/manual/card-reliability.md。最终回复只写普通文件路径和普通说明，
> 不要输出 paper_card 或 file_card fenced code block。

通过条件：

- 最终 assistant 正文只有普通说明/路径，没有任何 card fence。
- 同一 Run dock 显示既有 `2 tools / 0 Skills`（实际 Skills 数以本次执行为准）、
  正好一张 `outputs/manual/card-reliability.md` FileCard，以及一个默认收起的
  “检索结果·尚未筛选”分组。
- 分组明确说明结果是 raw retrieved，不能暗示精选、已读、已引用、已收藏、
  verified 或 Reliable Sources；首次只显示 3 条，展开后不超过硬上限。
- `matchedTotal / returned / eligible / stored / unique / shown` 按各自标签显示，
  不把命中总数写成已展示或已保存数。
- 聊天正文中不直接出现完整 `toolResult`、完整 params/result 或 reasoning。

失败判据：没有卡片、必须靠模型 fence 才有卡片、同一路径出现两张卡、raw
候选显示为“精选/可靠来源/已引用”、工具 badge 被卡片加载覆盖，或显示完整
工具返回。

## 3. 文件与文献操作

1. 点击 FileCard 的“打开文件”。预期系统打开真实文件；若 availability 仍是
   `unknown`，按钮必须禁用而不是盲开。
2. 对第一条有 strong identity 且可操作的 Candidate 点击“加入文献库”。预期
   成功后仅该候选变为“已收藏”；这不改变其 retrieved 语义。
3. 对无 DOI/arXiv/provider strong identity 的候选，预期不可执行入库操作。
4. 另起一轮对同一路径先 `workspace_save` 后 `workspace_append`。预期该 Run
   正好一张最新 FileCard。一次生成两个不同路径时应显示两张。
5. 让 `workspace_export` 使用一个不存在/不可转换的源文件。预期失败信息可见，
   但绝不制造成功 FileCard。

## 4. F5、切会话、重连与无 final

1. 在 A 中按 F5。预期工具/Skills badge、唯一 FileCard、Candidate 分组和已收藏
   状态同时恢复。
2. 新建空会话 B。B 不得显示 A 的 badge/card；快速 A→B→A 后，迟到 RPC
   不得把另一会话数据写回，A 返回时所有内容仍在。
3. 停止 `pnpm dev` 中 Gateway 后保留页面。预期显示“已断开/正在自动重连”，
   已有卡片保留；文件 availability 变为 unknown、操作禁用，断连不得冒充
   Run 失败。用相同配置重新启动后，预期自动重连并恢复 availability/操作。
4. 新开一轮，让模型先完成受支持工具调用、再继续一段较长说明；工具结束后
   立即取消或制造配置的短 timeout，使其没有 final assistant。预期 dock 停靠在
   对应 `<runId>:user` 用户回合，卡片仍可由 RPC 恢复，状态只服从 OC Session
   truth。断连本身不能把它标成失败。

## 5. Legacy 与状态 enrichment

1. 让一条测试消息同时包含合法 legacy `file_card` fence，且服务器事实中有同
   Run、同 path。预期正好一张卡，fence 前后 Agent 说明保留。
2. 对同一论文强 ID 同时存在 legacy `paper_card` 与 raw Candidate。预期 raw
   分组中不重复显示该项，但 Agent 主动精选说明保留。
3. 在卡片出现后从工作区外部移动/删除验收文件，再刷新 availability。预期分别
   显示 `missing/deleted`（按可确认事实），打开操作禁用；越界/绝对路径必须
   `blocked`，旧 Gateway/RPC 失败必须 `unknown`。
4. availability 或 Library saved 状态变化时，即使 `recordsRevision` 不变，UI
   也必须更新；反之不能伪造新的 immutable presentation record。

全部通过后，请明确回复“手工验收通过，可以合并”。收到该确认前，功能分支
不会合入 RC `main`。
