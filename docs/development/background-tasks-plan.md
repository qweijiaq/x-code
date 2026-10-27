# 后台任务与前台继续提问

> 实现状态（1.0.4）：A（后台 shell 自动收尾）、B（后台子代理）、C（排队问题在新窗口派生会话继续）已实现；同时补了 `backgroundList` / `backgroundGet` / `backgroundOutput` 查询工具、每轮后台摘要和跨窗口共享视图。下面是当时的方案与取舍记录。

## 结论

可行，但不建议在**同一个会话里并行跑两个完整 turn**。Claude Code 之所以能做到，是因为它把长任务放进**独立的会话/子代理上下文**，前台对话仍然只有一个 turn 在写自己的 transcript；两者通过任务状态和结果摘要汇合，而不是把两条消息流实时交织在一起。

X-Code Desktop 现在的限制也很明确：每个窗口的 runtime 只有一个 `AgentHost`，`submit()` 用 `activeTurn` 串行化整轮对话，`loadSession`、`revertEdit`、权限规则修改等操作也会因为 `activeTurn` 被拒绝。后台 shell 已经存在，但模型如果继续等待它，当前 turn 仍然占着前台；现有「停止等待」只是手动解法。

## 三种方案

### A. 后台 shell 自动收尾（最轻，推荐先做）

- 当 shell 工具返回 `running` + `shellId` 时，不再让模型轮询；提示模型立刻总结「已在后台运行」并结束当前 turn。
- 前台输入框随即恢复可用；后台 shell 继续运行，面板显示进度，完成后发通知。
- 用户再提问时是同一会话的下一个 turn，不涉及并发写 transcript。
- 工作量：**1–2 天**。改动集中在 shell 工具提示、agent loop 的停止条件和少量 UI 文案；复用现有后台任务面板。
- 局限：只解决「命令在后台跑」，不解决「整个 Agent 任务」在后台跑。

### B. 后台子代理（接近 Claude Code 的体验）

- 给 `task` 工具增加 `background: true`：主 turn 立即拿到 task id 并继续，子代理在独立 `LoopState` 里执行，完成后把摘要/结果作为事件送回。
- 需要：后台任务注册表、事件协议（`background:start/progress/end`）、权限请求队列（子代理的写操作仍要用户批准）、取消/重试、完成通知、结果「插入当前对话」或「打开完整会话」。
- 子代理默认仍然是独立上下文，不能看到主会话正在输入的内容；这符合 Claude Code 的模型。
- 工作量：**5–8 天**。核心改动在 `packages/core/src/agent/sub-agents/`、`tools/task.ts`、桌面 runtime 的 approval 路由和 BackgroundPanel。
- 适合：调查、代码审查、批量资料整理、长命令编排。

### C. 整轮自动分离到子会话（最接近「任务在后台，前台继续聊」）

- 用户在前台继续提问时，如果当前 turn 还在运行，把**新问题**（或当前长任务）自动 fork 成子会话：复制上下文快照、独立 runtime/`AgentHost`、独立 transcript，前台继续原会话。
- 子会话完成后只回传摘要、文件变更和结果卡片；用户可选择「并入当前对话」或「打开子会话」。
- 编码任务建议使用独立 worktree，避免两个 turn 同时改同一文件；写作/研究任务可共享工作区，但需要写锁。
- 工作量：**8–12 天**。需要多 runtime 生命周期、会话 fork 快照、事件路由、窗口/tab 的 background 状态、冲突检测、崩溃恢复。
- 这是最完整的方案，但仍不是「一个会话里两个并行 turn」。

### D. 同会话并行 turn（不建议）

真正让两个 turn 同时读写同一个 `LoopState`/transcript，需要：每 turn 上下文快照、消息顺序仲裁、模型请求并发、权限弹窗仲裁、文件写冲突、压缩边界、失败回滚、UI 交错渲染。Claude Code 也没有在主对话里这么做。按当前代码结构估计 **3–4 周**，且回归风险最高。

## 推荐路线

1. **先做 A（1–2 天）**：让「后台 shell 已启动」成为合法的 turn 结束状态，前台立刻可提问；这能覆盖大部分长命令场景。
2. **再做 B（5–8 天）**：把 `task` 变成可后台运行的子代理，补权限队列、后台面板、完成通知和结果插入。
3. **最后评估 C（8–12 天）**：只有当用户确实需要「整个编码任务后台跑」时再做自动分离 + worktree 隔离。
4. D 不做。

总计：A + B 约 **1.5–2 周**（含测试和桌面验收），C 再加 **2 周左右**。如果只做 A，先上一个小版本就能明显改善「前台被后台任务卡住」的体感。

## 验收标准（建议）

- 前台提交新问题后 1 秒内进入可输入状态；后台任务仍有独立进度和停止按钮。
- 后台任务的权限请求不会静默自动通过；用户不在时按拒绝/排队处理。
- 两个任务同时写工作区时，编码任务进入独立 worktree，或第二个写入被明确阻止。
- 后台完成只产生一条结果卡片/通知，不把原始消息流插进当前 transcript；用户主动选择才合并摘要。
- 窗口关闭、runtime 崩溃后，后台任务标记为「已中断」，可查看已产生的输出，不伪装成完成。
- 每个窗口限制并发后台任务数（建议 2），避免 provider 限流和 token 失控。

## 现有代码锚点

- `packages/desktop/src/runtime/agent-host.ts`：`activeTurn`、`submit()`、`buildCallbacks()`、session save。
- `packages/desktop/src/runtime/index.ts`：`agent:submit`、`agent:abort`、`background:list`、approval 路由。
- `packages/desktop/src/renderer/App.tsx`：`busy`、队列、`background-wait` banner、`BackgroundPanel`。
- `packages/core/src/agent/sub-agents/runner.ts`：子代理独立 `LoopState` 和权限过滤。
- `packages/core/src/tools/task.ts`：当前同步 `task` 工具。
- `packages/core/src/tools/shell-session/`：后台 shell 生命周期和输出。
