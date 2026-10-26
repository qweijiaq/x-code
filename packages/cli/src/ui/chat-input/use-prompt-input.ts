// @x-code-cli/cli — 自定义 stdin 输入 hook，带括号粘贴支持，并为不启用它的终端提供
// 时间窗回退。
//
// 两层粘贴检测策略：
//
//   1. **括号粘贴模式**（主路径、快路径）
//      挂载时我们发 `\x1b[?2004h`。支持它的终端会把每次粘贴都包在
//      `\x1b[200~ … \x1b[201~` 里。下面的状态机检测这些标记，并把负载作为单次
//      `onPaste` 调用发出，无论 Node 如何切分 stdin 字节。
//
//   2. **防抖回退**（针对 Windows Terminal / PowerShell / tmux / ConEmu /
//      VS Code 集成终端——任何不遵守括号粘贴的环境）
//      看不到粘贴标记时，粘贴嫌疑分块（>= PASTE_SIZE_THRESHOLD 字符、包含换行、
//      或在爆发进行中到达）会累积进一个缓冲，其 PASTE_DEBOUNCE_MS 定时器在每次
//      事件时重置，于是流一旦停顿，一次粘贴就作为单个原子分块 flush。单个按键绕
//      过缓冲并立即分发——人工打字永不承担防抖成本。这与 Claude Code 在其
//      `usePasteHandler` hook 里采用的方法相同。
//
// 特殊键（方向键、Esc、Ctrl+C、…）在分发前总会强制 flush 任何待处理文本，这样粘贴
// 的内容会在作用于它的按键之前被提交。爆发中途到达的 Enter / tab 改为被吸收进缓冲
// （backspace 修剪它）——在不支持括号粘贴的 Windows 终端上，裸 `\r` 只是粘贴的下一个
// 换行，把它当作 Return 会提交半段粘贴。
import { StringDecoder } from 'node:string_decoder'

import { useEffect, useRef } from 'react'

import { useStdin } from 'ink'

import { type DecodedPromptInput, PromptInputDecoder } from './prompt-input-decoder.js'

const ENABLE_BRACKETED_PASTE = '\x1b[?2004h'
const DISABLE_BRACKETED_PASTE = '\x1b[?2004l'
const INCOMPLETE_SEQUENCE_TIMEOUT_MS = 20

// 批量处理快速 stdin 爆发的时间窗。人工打字永不进入这个缓冲（单键分块立即分发），
// 所以宽松的窗口零成本；粘贴文本最多晚 100 ms 出现。窗口必须宽，因为不支持括号粘贴
// 的 Windows 终端会把一次粘贴滴成许多小 stdin 事件，而繁忙的事件循环（每次分发后的
// render + cell-diff）可能把分块间隔推到 30 ms 以上——更窄的窗口会在粘贴中途 flush，
// 把一次粘贴拆成乱序碎片。
const PASTE_DEBOUNCE_MS = 100

// 任何 >= 此大小（或含换行）的 stdin 分块都被怀疑是粘贴，走防抖缓冲，让连续碎片
// 合并成单次 onPaste 事件。低于此大小的分块按正常打字处理并立即分发——这与 Claude
// Code 的 PASTE_THRESHOLD (800) 做法一致。按住一个键会产生单字符 stdin 事件；用旧的
// 低阈值 (8) 时，每次按键都走防抖，感觉卡顿。
const PASTE_SIZE_THRESHOLD = 32

type PromptKey =
  | 'return'
  | 'newline'
  | 'backspace'
  | 'clear'
  | 'delete'
  | 'tab'
  | 'escape'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'home'
  | 'end'
  | 'pageup'
  | 'pagedown'

export interface PromptInputHandlers {
  /** 普通输入文本（如果终端批量了一次爆发，可能是多字符）。 */
  onText: (text: string) => void
  /** 原子粘贴——总是一次粘贴事件的完整内容。 */
  onPaste: (content: string) => void
  /** 特殊键。 */
  onKey: (key: PromptKey) => void
  /** Ctrl+C 时调用——应通过 useApp().exit() 触发干净的 Ink 卸载。 */
  onInterrupt: () => void
  /** 开关监听器，而无需卸载组件。 */
  enabled: boolean
}

export function usePromptInput({ onText, onPaste, onKey, onInterrupt, enabled }: PromptInputHandlers): void {
  const { stdin, setRawMode, internal_eventEmitter } = useStdin()

  // 把处理器藏进 ref，这样 effect 不会在每次渲染时重新订阅——每次渲染都产生一个新
  // 的回调闭包，但我们要一个稳定订阅，始终调用到最新的处理器。
  //
  // 赋值必须发生在 useEffect 里（而不是渲染期间），因为在渲染期间给 ref.current 赋
  // 值会被 React 的并发模式规则标记——它可能让 Strict Mode 的双重调用看到不匹配的
  // 状态。一个没有依赖数组的 effect 在每次 commit 后运行，正是我们想要的「最新值」
  // 语义。
  const handlersRef = useRef({ onText, onPaste, onKey, onInterrupt })
  useEffect(() => {
    handlersRef.current = { onText, onPaste, onKey, onInterrupt }
  })

  // 回退路径的防抖缓冲 + 定时器。
  const pendingTextRef = useRef<string>('')
  const pendingTimerRef = useRef<NodeJS.Timeout | null>(null)

  // 即使输入被禁用（例如加载中），Ctrl+C 也必须生效。我们始终在 stdin 上监听
  // \x03，并把它路由到 onInterrupt。当 enabled=false 时，其他所有输入都被忽略。
  useEffect(() => {
    if (!enabled) {
      // 最小监听器：只处理 Ctrl+C，忽略其他一切。
      setRawMode(true)
      const handleCtrlC = (data: Buffer | string): void => {
        const chunk = typeof data === 'string' ? data : data.toString('utf8')
        if (chunk.includes('\x03')) {
          handlersRef.current.onInterrupt()
        }
      }
      internal_eventEmitter.on('input', handleCtrlC)
      return () => {
        internal_eventEmitter.off('input', handleCtrlC)
        setRawMode(false)
      }
    }

    setRawMode(true)
    process.stdout.write(ENABLE_BRACKETED_PASTE)
    const useBracketedPaste = true
    const inputDecoder = new PromptInputDecoder()
    const utf8Decoder = new StringDecoder('utf8')
    let sequenceTimer: ReturnType<typeof setTimeout> | null = null
    let pasteTimer: ReturnType<typeof setTimeout> | null = null

    // ── Flush 防抖缓冲 ──
    //
    // 发出一次 onPaste（微小分块则 onText），携带上一次爆发期间累积的所有文本。我们
    // 在这里把行尾归一化为 `\n`，因为 Windows 终端倾向把粘贴的换行发成 `\r` 或
    // `\r\n`；下游代码和终端的行渲染都想要 `\n`。终端打印里的裸 `\r` 表示「回车」并
    // 会覆盖之前的字符，这曾产生回显粘贴里的
    // "optimizations Claude Managed Agents is currently in beta" 拼接模式。
    const flushPending = (): void => {
      if (pendingTimerRef.current) {
        clearTimeout(pendingTimerRef.current)
        pendingTimerRef.current = null
      }
      const raw = pendingTextRef.current
      if (!raw) return
      pendingTextRef.current = ''
      const text = raw.replace(/\r\n?/g, '\n')

      const looksLikePaste = text.length >= PASTE_SIZE_THRESHOLD || text.includes('\n')
      if (looksLikePaste) {
        handlersRef.current.onPaste(text)
      } else {
        handlersRef.current.onText(text)
      }
    }

    // 从最近一次事件开始防抖：每个排队的分块都重置定时器，流一停顿缓冲就 flush。这
    // 里刻意没有最大批量上限——只有粘贴嫌疑分块（>= PASTE_SIZE_THRESHOLD 字符、含换
    // 行、或爆发中途到达）进入这个缓冲；按键重复产生绕过它的单字符事件（见
    // processNormalInput）。硬上限曾在 Windows 上于粘贴中途强制 flush——ConPTY 把数
    // KB 的粘贴作为跨越 >50 ms 的许多 stdin 事件投递，把一次粘贴拆成乱序碎片。
    const armFlushTimer = (): void => {
      if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current)
      pendingTimerRef.current = setTimeout(flushPending, PASTE_DEBOUNCE_MS)
    }

    // 把文本排进防抖缓冲，并（重新）启动 flush 定时器。
    const queueText = (data: string): void => {
      pendingTextRef.current += data
      armFlushTimer()
    }

    // 分发一个特殊键。总是先强制 flush 待处理文本，这样比如 Enter 会在作用于按键之
    // 前提交之前缓冲的输入。
    const dispatchKey = (key: PromptKey): void => {
      flushPending()
      handlersRef.current.onKey(key)
    }

    // 解析一段非粘贴输入。识别出的特殊键立即返回；否则作为文本缓冲。
    const processNormalInput = (data: string): void => {
      if (data.length === 0) return

      // 一旦防抖缓冲里有了粘贴嫌疑文本，粘贴爆发就在进行中：流停顿之前到达的一切都
      // 属于同一次爆发。不支持括号粘贴的 Windows 终端（ConPTY）把一次粘贴滴成许多小
      // stdin 事件——短的尾行、裸 `\r` 字节、制表符——它们各自都低于
      // PASTE_SIZE_THRESHOLD。让它们走下面的即时路径会在粘贴中途强制 flush 缓冲，把
      // 一次粘贴拆成乱序碎片（裸 `\r` 甚至可能通过 dispatchKey('return') 提前提交）。
      const burstInProgress = pendingTextRef.current.length > 0

      if (data === '\r' || data === '\n') {
        if (burstInProgress) return queueText(data)
        return dispatchKey('return')
      }
      if (data === '\x7f' || data === '\b') {
        // 如果防抖缓冲有待处理文本，就修剪缓冲来吸收退格，而不是 flush + 分发。
        if (pendingTextRef.current.length > 0) {
          pendingTextRef.current = pendingTextRef.current.slice(0, -1)
          return
        }
        // 立即分发，让按住退格感觉跟手（之前 queueBackspace 坐在防抖缓冲里，定时器
        // 在每个重复事件上都重置，视觉上把删除冻结到松键为止）。
        dispatchKey('backspace')
        return
      }
      if (data === '\t') {
        if (burstInProgress) return queueText(data)
        return dispatchKey('tab')
      }

      // Shell 原生的清空输入快捷键。Ctrl+U 是 macOS 和 Linux 上熟悉的 zsh/readline
      // 绑定；PowerShell 默认的 Windows 编辑模式用 Ctrl+Home。把两者都当作一次原子清
      // 空，这样多行草稿和紧凑的粘贴引用也一并移除。
      if (data === '\x15') return dispatchKey('clear')
      if (data === '\x1b[1;5H' || data === '\x1b[1;5~') return dispatchKey('clear')

      // Alt/Option+Enter → 插入字面换行。多数区分 Alt 修饰键的终端发送前缀 ESC 形式：
      // `\x1b\r`（Windows Terminal / Linux xterm / 带 "Esc+" Option 映射的 iTerm2 上
      // 的 Alt+Enter），少数发 `\x1b\n`。下面的 CSI 形式来自 modifyOtherKeys / kitty
      // 键盘协议——在我们目标的所有环境中默认都不启用，但如果有高级用户打开了它们，
      // 我们也予以支持。
      //   xterm modifyOtherKeys: ESC [27;3;13~ (Alt+Enter), ESC [27;5;13~ (Ctrl+Enter)
      //   kitty CSI-u:           ESC [13;3u   (Alt+Enter), ESC [13;5u   (Ctrl+Enter)
      // 裸 Ctrl+Enter 在标准终端上与 Enter 无法区分；kitty/modifyOtherKeys 的 CSI 形式
      // 是它能到达我们的唯一途径，所以它们被当作与 Alt+Enter 完全相同。
      if (data === '\x1b\r' || data === '\x1b\n') return dispatchKey('newline')
      if (data === '\x1b[27;3;13~' || data === '\x1b[27;5;13~') return dispatchKey('newline')
      if (data === '\x1b[13;3u' || data === '\x1b[13;5u') return dispatchKey('newline')

      if (data === '\x1b' || data === '\x1b\x1b') return dispatchKey('escape')

      // Ctrl+C——flush 并调用中断处理器（它通过 useApp().exit() 触发 Ink 的干净卸载）。
      // 我们不发送 SIGINT，因为在 Windows 上，signal-exit 会在运行回调后重新抛出它，
      // 导致进程在 gracefulShutdown 运行前就以代码 1 退出。
      if (data === '\x03') {
        flushPending()
        handlersRef.current.onInterrupt()
        return
      }

      // ANSI 方向键和导航（精确匹配）
      if (data === '\x1b[A') return dispatchKey('up')
      if (data === '\x1b[B') return dispatchKey('down')
      if (data === '\x1b[C') return dispatchKey('right')
      if (data === '\x1b[D') return dispatchKey('left')
      if (data === '\x1b[H' || data === '\x1b[1~') return dispatchKey('home')
      if (data === '\x1b[F' || data === '\x1b[4~') return dispatchKey('end')
      if (data === '\x1b[3~') return dispatchKey('delete')
      if (data === '\x1b[5~') return dispatchKey('pageup')
      if (data === '\x1b[6~') return dispatchKey('pagedown')
      // （模式循环键绑定——Shift+Tab `\x1b[Z` 和 Alt+M `\x1b m` 的 Windows 回退——已
      // 移除；模式切换现在完全由斜杠命令驱动。见 ChatInput 提示文本和 App.tsx 里的
      // /plan 处理器。）

      // 未知转义序列——丢弃，避免它们以字面 "\x1b[…" 文本出现在输入里。
      if (data.startsWith('\x1b')) return

      // 可打印文本。两条路径：
      //  - 粘贴嫌疑分块（大、多行、或爆发进行中到达）走防抖缓冲，让跨多个 stdin 事件
      //    的粘贴合并成一次 onPaste 调用。
      //  - 无爆发进行中的小单键分块立即分发。按住一个键会以约 30 Hz 触发 stdin 事件，
      //    对每个都防抖会让输入感觉冻结 / 卡顿。Claude Code 也这么做（他们的
      //    usePasteHandler 对 input.length < PASTE_THRESHOLD 绕过粘贴缓冲）。
      if (burstInProgress || data.length >= PASTE_SIZE_THRESHOLD || data.includes('\n')) {
        queueText(data)
      } else {
        handlersRef.current.onText(data)
      }
    }

    const dispatchDecoded = (events: DecodedPromptInput[]): void => {
      for (const event of events) {
        if (event.type === 'paste') {
          flushPending()
          handlersRef.current.onPaste(event.value)
        } else {
          processNormalInput(event.value)
        }
      }
    }

    const clearSequenceTimer = (): void => {
      if (sequenceTimer) clearTimeout(sequenceTimer)
      sequenceTimer = null
    }

    const clearPasteTimer = (): void => {
      if (pasteTimer) clearTimeout(pasteTimer)
      pasteTimer = null
    }

    const armDecoderTimers = (): void => {
      clearSequenceTimer()
      if (inputDecoder.inPaste()) {
        clearPasteTimer()
        pasteTimer = setTimeout(() => {
          pasteTimer = null
          dispatchDecoded(inputDecoder.flush())
        }, 1000)
        return
      }
      clearPasteTimer()
      if (inputDecoder.hasPending()) {
        sequenceTimer = setTimeout(() => {
          sequenceTimer = null
          dispatchDecoded(inputDecoder.flush())
        }, INCOMPLETE_SEQUENCE_TIMEOUT_MS)
      }
    }

    // Node 分块是任意字节组，不是按键事件。增量解码它们，让组合键和被拆开的
    // CSI/粘贴标记都能工作。
    const handleData = (data: Buffer | string): void => {
      const chunk = typeof data === 'string' ? data : utf8Decoder.write(data)
      if (!chunk) return

      // 无标记粘贴回退：内部换行很可能是剪贴板内容。排除尾随 Return，这样 `abc\r`
      // 会打字然后提交。
      if (
        !inputDecoder.inPaste() &&
        !chunk.includes('\x1b') &&
        (chunk.length >= PASTE_SIZE_THRESHOLD || /[\r\n][\s\S]+/.test(chunk))
      ) {
        queueText(chunk)
        return
      }

      clearSequenceTimer()
      dispatchDecoded(inputDecoder.push(chunk))
      armDecoderTimers()
    }

    // Ink 拥有 stdin 的 `readable` 监听器，并自己排空流。并行监听 `data` 会与那次排
    // 空竞争并可能丢失输入；它的 input 发射器是 useInput 使用的唯一读后投递路径。
    internal_eventEmitter.on('input', handleData)
    return () => {
      flushPending()
      clearSequenceTimer()
      clearPasteTimer()
      inputDecoder.reset()
      internal_eventEmitter.off('input', handleData)
      if (useBracketedPaste) {
        process.stdout.write(DISABLE_BRACKETED_PASTE)
      }
      setRawMode(false)
    }
  }, [enabled, stdin, setRawMode, internal_eventEmitter])
}
