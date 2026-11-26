// @x-code-cli/cli — 消息 id 生成
//
// DisplayMessage.id 是渲染层与滚动缓冲区的身份键（见 agent-tool-lifecycle：
// 重复 id 会让两条消息被当成同一条，后者的内容覆盖/吞掉前者）。裸
// `Date.now()` 在同一毫秒内的多次调用会得到同一个值——斜杠命令「先回显、
// 再出结果」几乎必然落在同一毫秒，系统时钟回拨（NTP 校时）时更糟。
//
// 因此 id = 前缀 + 时间戳 + 进程内单调递增序号：时间戳保持大致有序（便于
// 阅读与排序，也保留原有前缀语义），序号保证唯一性。
let sequence = 0

export function nextMessageId(prefix: string, now: number = Date.now()): string {
  sequence += 1
  return `${prefix}-${now}-${sequence}`
}
