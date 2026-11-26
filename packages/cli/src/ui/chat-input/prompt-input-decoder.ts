const ESC = '\x1b'
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
/** paste 态缓冲上限：超过即认为结束标记已丢失，把已有内容当作一次粘贴产出。 */
const MAX_PASTE_CHARS = 4 * 1024 * 1024

export type DecodedPromptInput = { type: 'normal' | 'paste'; value: string }

function suffixPrefixLength(value: string, marker: string): number {
  const max = Math.min(value.length, marker.length - 1)
  for (let length = max; length > 0; length--) {
    if (value.endsWith(marker.slice(0, length))) return length
  }
  return 0
}

/** 增量分词终端输入，而不假设 Node 的分块边界与按键或括号粘贴标记对齐。 */
export class PromptInputDecoder {
  private pending = ''
  private pasteBuffer = ''
  private paste = false

  push(value: string): DecodedPromptInput[] {
    this.pending += value
    return this.drain(false)
  }

  flush(): DecodedPromptInput[] {
    return this.drain(true)
  }

  reset(): void {
    this.pending = ''
    this.pasteBuffer = ''
    this.paste = false
  }

  hasPending(): boolean {
    // paste 态下内容已经搬进 `pasteBuffer`、`pending` 被清空，只看 `pending`
    // 会让调用方误判「解码器已空」并 reset/退出，把粘贴内容丢掉。
    return this.pending.length > 0 || (this.paste && this.pasteBuffer.length > 0)
  }

  inPaste(): boolean {
    return this.paste
  }

  private drain(flush: boolean): DecodedPromptInput[] {
    const out: DecodedPromptInput[] = []
    while (this.pending.length > 0) {
      if (this.paste) {
        const end = this.pending.indexOf(PASTE_END)
        if (end >= 0) {
          this.pasteBuffer += this.pending.slice(0, end)
          // 空内容不产出事件，与 flush 分支的 `if (this.pasteBuffer)` 守卫保持一致
          // ——否则调用方会收到一次「无内容的粘贴」（多余 undo 步 / 提交历史）。
          if (this.pasteBuffer) out.push({ type: 'paste', value: this.pasteBuffer.replace(/\r\n?/g, '\n') })
          this.pasteBuffer = ''
          this.paste = false
          this.pending = this.pending.slice(end + PASTE_END.length)
          continue
        }
        if (flush) {
          this.pasteBuffer += this.pending
          this.pending = ''
          if (this.pasteBuffer) out.push({ type: 'paste', value: this.pasteBuffer.replace(/\r\n?/g, '\n') })
          this.pasteBuffer = ''
          this.paste = false
          break
        }
        const keep = suffixPrefixLength(this.pending, PASTE_END)
        this.pasteBuffer += this.pending.slice(0, this.pending.length - keep)
        this.pending = this.pending.slice(this.pending.length - keep)
        if (this.pasteBuffer.length > MAX_PASTE_CHARS) {
          // 结束标记可能永远不来（括号粘贴被截断、SSH/tmux 丢块）。此时后续所有
          // 键盘输入都会被吞进 paste 态、缓冲无上限增长，用户表现为「输入完全无
          // 响应 + 内存上涨」。超限就把已有内容当作一次粘贴产出并退出 paste 态，
          // 让输入恢复响应。
          out.push({ type: 'paste', value: this.pasteBuffer.replace(/\r\n?/g, '\n') })
          this.pasteBuffer = ''
          this.paste = false
        }
        break
      }

      if (this.pending.startsWith(PASTE_START)) {
        this.pending = this.pending.slice(PASTE_START.length)
        this.paste = true
        continue
      }
      if (!flush && PASTE_START.startsWith(this.pending)) break

      if (this.pending[0] === ESC) {
        if (this.pending.length === 1 && !flush) break
        if (this.pending.startsWith(ESC + ESC)) {
          out.push({ type: 'normal', value: ESC + ESC })
          this.pending = this.pending.slice(2)
          continue
        }
        // CSI（`ESC [`）与 SS3（`ESC O`，application 模式方向键 / F1-F4）的
        // 参数与终止字节布局相同，都必须整体扫描到终止字节；只认 `[` 会让
        // `\x1bOP` 拆成「ESC」+「P」两个 token，上层会当成 Esc + 输入字符 P。
        if (this.pending[1] === '[' || this.pending[1] === 'O') {
          let end = 2
          while (end < this.pending.length && !/[\x40-\x7e]/.test(this.pending[end]!)) end++
          if (end >= this.pending.length && !flush) break
          const length = end < this.pending.length ? end + 1 : this.pending.length
          out.push({ type: 'normal', value: this.pending.slice(0, length) })
          this.pending = this.pending.slice(length)
          continue
        }
        // 两字节转义（`ESC 7`、`ESC =`…）：没有更多字节可等，最多消费 2 个。
        const length = Math.min(2, this.pending.length)
        out.push({ type: 'normal', value: this.pending.slice(0, length) })
        this.pending = this.pending.slice(length)
        continue
      }

      const first = this.pending.charCodeAt(0)
      if (first <= 0x1f || first === 0x7f || (first >= 0x80 && first <= 0x9f)) {
        out.push({ type: 'normal', value: this.pending[0]! })
        this.pending = this.pending.slice(1)
        continue
      }

      let end = 1
      while (end < this.pending.length) {
        const unit = this.pending.charCodeAt(end)
        if (unit === 0x1b || unit <= 0x1f || unit === 0x7f || (unit >= 0x80 && unit <= 0x9f)) break
        end++
      }
      out.push({ type: 'normal', value: this.pending.slice(0, end) })
      this.pending = this.pending.slice(end)
    }
    return out
  }
}
