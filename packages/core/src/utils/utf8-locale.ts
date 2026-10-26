// GUI-launched apps inherit no LANG/LC_CTYPE, so child shells can end up in the
// C locale and mangle non-ASCII paths and tool output. Normalize only the
// locale variables to UTF-8; other user environment stays untouched.
const UTF8_LOCALE = 'en_US.UTF-8'

export function isUtf8Locale(value: string | undefined): boolean {
  return value !== undefined && /utf-?8/i.test(value)
}

export function applyUtf8Locale(env: Record<string, string | undefined>): void {
  if (env.LC_ALL && !isUtf8Locale(env.LC_ALL)) env.LC_ALL = UTF8_LOCALE
  if (env.LC_CTYPE && !isUtf8Locale(env.LC_CTYPE)) env.LC_CTYPE = UTF8_LOCALE
  if (!isUtf8Locale(env.LANG)) env.LANG = UTF8_LOCALE
}
