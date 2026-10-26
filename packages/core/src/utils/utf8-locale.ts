// 由 GUI 启动的应用不会继承 LANG/LC_CTYPE，因此子 shell 可能落入 C locale，
// 从而弄乱非 ASCII 路径和工具输出。只把 locale 变量归一化为 UTF-8；其他
// 用户环境变量保持不变。
const UTF8_LOCALE = 'en_US.UTF-8'

export function isUtf8Locale(value: string | undefined): boolean {
  return value !== undefined && /utf-?8/i.test(value)
}

export function applyUtf8Locale(env: Record<string, string | undefined>): void {
  if (env.LC_ALL && !isUtf8Locale(env.LC_ALL)) env.LC_ALL = UTF8_LOCALE
  if (env.LC_CTYPE && !isUtf8Locale(env.LC_CTYPE)) env.LC_CTYPE = UTF8_LOCALE
  if (!isUtf8Locale(env.LANG)) env.LANG = UTF8_LOCALE
}
