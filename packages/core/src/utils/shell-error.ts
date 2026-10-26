// @x-code-cli/core — Shell 标准错误噪声折叠
//
// PowerShell 和 cmd 会为每个解析/语法错误输出多行诊断：`At line:X char:Y`
// 头部、一行出错的源码、一行插入符下划线（`+ ~~~~`）、一行自由格式描述，
// 然后是尾部标记（`+ CategoryInfo` 和 `+ FullyQualifiedErrorId`）。当 agent
// 反复尝试一条引号错误的命令时，这些 5–10 行的堆栈会比真正的诊断信号更快
// 地塞满上下文。我们把每个块折叠成单行。
//
// 检测模型：
//   - 一个块在匹配 `At line:X char:Y` 的行处开始。
//   - 一个块在以下最先出现处结束：(a) `FullyQualifiedErrorId` 行
//     （它始终是 PS 输出的终止符），(b) 另一个块的开始，(c) 硬性扫描上限。
//   - 扫描上限用于防范缺少 FQID 行的病态输入——我们不会悄悄吞掉无关输出。

/** 单个块最多消费的行数。PS 堆栈约 5 行，绝不会接近 12；超过这个数的内容
 *  大概不属于该块。 */
const BLOCK_SCAN_LIMIT = 12

const PS_BLOCK_START = /^At line:\d+ char:\d+/
const PS_FQID_LINE = /^\s*\+\s*FullyQualifiedErrorId\s*:/

function isBlockStart(line: string): boolean {
  return PS_BLOCK_START.test(line)
}

function isFqidTerminator(line: string): boolean {
  return PS_FQID_LINE.test(line)
}

/**
 * 把 `text` 中的每个 PowerShell 错误块折叠成单行摘要。摘要保留开头的
 * `At line:X char:Y` 头部（我们唯一保留的诊断信号），并丢弃正文、插入符、
 * 类别和 fully-qualified-id 的续行。
 *
 * 若未找到可识别的块则原样返回输入。可安全用于任意 shell 输出——不属于任何
 * 块的行会逐字通过。
 */
export function foldShellErrorNoise(text: string): string {
  if (!text) return text
  // 快速路径：大多数 shell 输出不是 PS 错误堆栈。
  if (!text.includes('At line:')) return text

  const lines = text.split(/\r?\n/)
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!isBlockStart(line)) {
      out.push(line)
      i++
      continue
    }

    out.push(`${line.trim()} [PS parse error — details folded]`)
    i++

    // 消费块主体。我们在自然终止符（`FullyQualifiedErrorId`）或新的块头部
    // （以防多个错误被拼接）处停止。扫描上限是防御性兜底；真实的 PS 错误
    // 永远到不了这里。
    let scanned = 0
    while (i < lines.length && scanned < BLOCK_SCAN_LIMIT) {
      if (isBlockStart(lines[i])) break
      const terminator = isFqidTerminator(lines[i])
      i++
      scanned++
      if (terminator) break
    }
  }

  return out.join('\n')
}
