// ChatInput 里文本 + 光标原子更新的 reducer。
//
// 输入缓冲的所有变更都经过 `useReducer(inputReducer)`，这样同时编辑文本又移动光标
// 的单次按键会作为一次状态转换提交（不会出现光标位置错误的中间帧）。

export interface InputState {
  text: string
  cursor: number
}

export type InputAction =
  | { type: 'INSERT'; pos: number; chunk: string }
  | { type: 'BACKSPACE_REF'; pos: number; deleteCount: number }
  | { type: 'DELETE'; pos: number }
  | { type: 'SET_CURSOR'; cursor: number }
  | { type: 'SET_TEXT'; text: string; cursor: number }
  | { type: 'RESET' }

export function inputReducer(state: InputState, action: InputAction): InputState {
  switch (action.type) {
    case 'INSERT': {
      const { pos, chunk } = action
      // 空块不该产生新 state 引用（会破坏下游的 bail-out 短路）。
      if (!chunk) return state
      // `pos` 是外部传入的：为负时 `slice(0, 负数)` 按「从末尾倒数」工作（插入
      // 位置错误、`cursor` 还可能为负），超过 `text.length` 时 `cursor` 会越界，
      // 后续按键定位与渲染切片一起错位。与 BACKSPACE_REF 一样先 clamp。
      const at = Math.max(0, Math.min(pos, state.text.length))
      return {
        text: state.text.slice(0, at) + chunk + state.text.slice(at),
        cursor: at + chunk.length,
      }
    }
    case 'BACKSPACE_REF': {
      const { pos, deleteCount } = action
      // `inputReducer` 是导出的公共函数，不能假设调用方一定传入 `0 <= deleteCount
      // <= pos`：`pos - deleteCount` 为负时 `slice(0, 负数)` 会按「从末尾倒数」的
      // 语义工作——文本没被正确删除，`cursor` 还变成负值并一路传染到 `cursorRef`、
      // 渲染切片和后续按键定位，属于静默的状态损坏。这里先 clamp 再判断是否真的
      // 有内容被删除，没有则短路返回原 state（与 SET_CURSOR 的 bail-out 风格一致）。
      const from = Math.max(0, Math.min(pos, state.text.length))
      const to = Math.max(0, from - Math.max(0, deleteCount))
      if (to === from) return state
      return {
        text: state.text.slice(0, to) + state.text.slice(from),
        cursor: to,
      }
    }
    case 'DELETE': {
      const { pos } = action
      // 非法位置必须显式拒绝：负数会让 `slice(0, -1)` 按「从末尾倒数」工作，
      // 删除的是错误字符且文本被拼接复制（`pos=-1` 时 `"abc"` → `"ababc"`）。
      if (!Number.isInteger(pos) || pos < 0 || pos >= state.text.length) return state
      return { text: state.text.slice(0, pos) + state.text.slice(pos + 1), cursor: state.cursor }
    }
    case 'SET_CURSOR': {
      const cursor = Math.max(0, Math.min(action.cursor, state.text.length))
      return state.cursor === cursor ? state : { ...state, cursor }
    }
    case 'SET_TEXT': {
      // `cursor` 必须落在新文本范围内：粘贴 / 补全后带着旧文本的光标位置会让
      // `cursorRef`、渲染切片和后续按键定位一起错位。
      const cursor = Math.max(0, Math.min(action.cursor, action.text.length))
      if (state.text === action.text && state.cursor === cursor) return state
      return { text: action.text, cursor }
    }
    case 'RESET':
      return { text: '', cursor: 0 }
    default:
      return state
  }
}
