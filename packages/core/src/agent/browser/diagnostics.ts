// @x-code-cli/core — 对进入模型上下文或终端 UI 之前的浏览器/MCP 诊断信息做脱敏。
import { redactMemoryText } from '../../knowledge/memory/redaction.js'

const CONTROL_CHAR_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g
// 零宽字符、双向嵌入/覆盖（Trojan Source 类可逆伪装）、隔离符、BOM、软连字符：
// 肉眼不可见，但能伪造终端输出，也能在进入模型上下文时藏匿提示注入指令。
const FORMAT_CHAR_RE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g
const ANSI_ESCAPE_RE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?)/g
// 值不能吃到引号 / 括号 / 标签边界：序列化成 JSON 的诊断里，贪婪的 `[^&\s]+`
// 会把 `","headers":{"Authorization":"Bearer` 整段吞进 URL 值，导致后面的
// Bearer / JSON 字段规则再也匹配不到真正的密钥。
const URL_SECRET_RE =
  /([#?&](?:access[_-]?token|api[_-]?key|auth|authorization|code|cookie|credential|jwt|key|password|passwd|secret|session(?:id)?|signature|token)=)[^&\s"'<>}\]]+/gi
const AUTH_HEADER_RE = /(\b(?:Authorization|Cookie|Set-Cookie)\s*:\s*)[^\r\n]+/gi
const BEARER_TOKEN_RE = /(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g
// 复合标识符（authToken / xApiKey / browserStorageToken / refresh_token …）不必
// 逐个枚举：任何以敏感后缀结尾、且后面不再是字母数字（避免误伤 tokenCount /
// keyboard / monkey）的名字都算。前一条枚举保留，用来覆盖 auth / key 这类无后缀名。
const SECRET_FIELD_NAME = String.raw`(?:(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|auth|authorization|cookie|credential|jwt|key|password|passwd|private[_-]?key|secret|session(?:[_-]?id)?|signature|token)|accessToken|apiKey|clientSecret|idToken|privateKey|refreshToken|secretAccessKey|sessionId|[A-Za-z0-9_]*[-_]?(?:token|secret|passwd|password|apikey|cert|credential)(?![a-z0-9]))`
const JSON_SECRET_RE = new RegExp(`("${SECRET_FIELD_NAME}"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`, 'gi')
const LABELED_SECRET_RE = new RegExp(
  `(\\b${SECRET_FIELD_NAME}\\b\\s*[:=]\\s*)(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,;}]+)`,
  'gi',
)

/** 对非字符串诊断值做显式序列化：`String({stderr,url})` 只会得到 `[object Object]`，
 *  信息全部丢失，而且后续所有脱敏正则都再也命中不到嵌套字段。 */
function stringifyDiagnostic(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value) ?? String(value)
    } catch {
      // 循环引用 / BigInt 等无法序列化的值：退回到 String，不要让诊断本身抛错。
      return String(value)
    }
  }
  return String(value)
}

export function sanitizeBrowserDiagnostic(value: unknown, maxChars = 3_000, emptyFallback = '(none reported)'): string {
  const sanitized = redactMemoryText(
    stringifyDiagnostic(value ?? '')
      .replace(ANSI_ESCAPE_RE, '')
      .replace(CONTROL_CHAR_RE, '')
      .replace(FORMAT_CHAR_RE, '')
      .replace(URL_SECRET_RE, '$1[REDACTED]')
      .replace(AUTH_HEADER_RE, '$1[REDACTED]')
      .replace(BEARER_TOKEN_RE, '$1[REDACTED]')
      .replace(JWT_RE, '[REDACTED_JWT]')
      .replace(JSON_SECRET_RE, '$1"[REDACTED]"')
      .replace(LABELED_SECRET_RE, '$1[REDACTED]'),
  ).trim()
  if (!sanitized) return emptyFallback
  if (sanitized.length <= maxChars) return sanitized
  return `${sanitized.slice(0, maxChars)}\n[browser diagnostics truncated]`
}
