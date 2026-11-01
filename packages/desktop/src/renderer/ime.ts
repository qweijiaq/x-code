// 中文输入法用 Enter 确认候选词。部分输入法会先结束组词再派发这次 keydown，
// 此时 isComposing 已经是 false，因此除了事件自身标记，还要记录组词刚结束的短窗口。
const COMPOSITION_GRACE_MS = 120

let composing = false
let endedAt = 0

if (typeof window !== 'undefined') {
  // 捕获阶段监听，任何输入元素（包括弹层里的临时输入框）都能覆盖。
  window.addEventListener(
    'compositionstart',
    () => {
      composing = true
    },
    true,
  )
  window.addEventListener(
    'compositionend',
    () => {
      composing = false
      endedAt = Date.now()
    },
    true,
  )
}

interface ImeEventLike {
  keyCode?: number
  isComposing?: boolean
  nativeEvent?: { isComposing?: boolean }
}

/** 这次按键属于正在进行的组词（方向键、Esc、Enter 都应交给输入法）。 */
export function isImeEvent(event: ImeEventLike): boolean {
  return composing || event.nativeEvent?.isComposing === true || event.isComposing === true || event.keyCode === 229
}

/** Enter 是否应当视为“确认候选词”而不是提交动作。 */
export function isImeEnter(event: ImeEventLike): boolean {
  return isImeEvent(event) || Date.now() - endedAt < COMPOSITION_GRACE_MS
}
