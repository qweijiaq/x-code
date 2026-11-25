// 中文输入法用 Enter 确认候选词。部分输入法会先结束组词再派发这次 keydown，
// 此时 isComposing 已经是 false，因此除了事件自身标记，还要记录组词刚结束的短窗口。
const COMPOSITION_GRACE_MS = 120

let composing = false
// 单调时钟：墙钟被 NTP 回拨/时区调整时，grace 窗口会被异常拉长或提前失效。
let endedAt = 0
/** 正在/刚结束组词的元素；grace 只对该元素生效。 */
let compositionTarget: EventTarget | null = null
/** 待消费的 grace：确认候选词的那一次 Enter 会把它一次性消费掉。 */
let graceTarget: EventTarget | null = null

function finishComposition(): void {
  if (!composing) return
  composing = false
  endedAt = performance.now()
  graceTarget = compositionTarget
}

/** 事件是否发生在组词元素内部（不依赖 DOM 全局，便于在 node 环境下测试）。 */
function isInsideCompositionTarget(target: EventTarget | null): boolean {
  const host = compositionTarget as (EventTarget & { contains?: (node: EventTarget | null) => boolean }) | null
  if (!host || typeof host.contains !== 'function' || !target) return false
  return host.contains(target)
}

if (typeof window !== 'undefined') {
  // 捕获阶段监听，任何输入元素（包括弹层里的临时输入框）都能覆盖。
  window.addEventListener(
    'compositionstart',
    (event) => {
      composing = true
      compositionTarget = event.target
      graceTarget = null
    },
    true,
  )
  window.addEventListener(
    'compositionend',
    () => {
      finishComposition()
    },
    true,
  )
  // 兜底：组词过程中元素被卸载/窗口失焦时 compositionend 可能根本不派发
  // （事件派发在已脱离文档的元素上，无法冒泡到 window），否则 composing 会
  // 永久为 true 并吞掉全应用所有 Enter/Esc。blur 捕获阶段包含元素失焦。
  window.addEventListener(
    'blur',
    () => {
      finishComposition()
    },
    true,
  )
  window.addEventListener(
    'focusout',
    () => {
      finishComposition()
    },
    true,
  )
  // 元素在组词期间被移除时既没有 compositionend 也没有 focusout：
  // 只要指针落在组词元素之外，就认为组词已经结束。
  window.addEventListener(
    'pointerdown',
    (event) => {
      if (!composing) return
      if (isInsideCompositionTarget(event.target)) return
      finishComposition()
    },
    true,
  )
}

interface ImeEventLike {
  keyCode?: number
  isComposing?: boolean
  nativeEvent?: { isComposing?: boolean }
  target?: EventTarget | null
}

/** 这次按键属于正在进行的组词（方向键、Esc、Enter 都应交给输入法）。 */
export function isImeEvent(event: ImeEventLike): boolean {
  return composing || event.nativeEvent?.isComposing === true || event.isComposing === true || event.keyCode === 229
}

/** Enter 是否应当视为“确认候选词”而不是提交动作。 */
export function isImeEnter(event: ImeEventLike): boolean {
  if (isImeEvent(event)) return true
  if (!graceTarget) return false
  if (performance.now() - endedAt >= COMPOSITION_GRACE_MS) {
    graceTarget = null
    return false
  }
  // grace 只对“刚结束组词的那个元素”生效：在别的元素上按 Enter（重命名框、
  // 按钮、树节点）是真实提交，不能被误吞。
  if (event.target !== undefined && event.target !== graceTarget) return false
  // 确认候选词的这次 Enter 消费掉 grace，紧随其后的真实提交不会再被吞。
  graceTarget = null
  return true
}
