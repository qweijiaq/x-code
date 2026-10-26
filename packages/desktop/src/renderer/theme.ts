// 主题偏好：浅色、深色或跟随系统。解析后的值写入 <html data-theme>，
// ink-wash 的 CSS 变量以此为依据。
export type ThemeSetting = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'xcode.theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

export function storedTheme(): ThemeSetting {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
  } catch {
    return 'system'
  }
}

function resolvedTheme(setting: ThemeSetting): 'light' | 'dark' {
  if (setting !== 'system') return setting
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
}

export function applyTheme(setting: ThemeSetting): void {
  const root = document.documentElement
  root.dataset.theme = resolvedTheme(setting)
  root.dataset.themeSetting = setting
  try {
    localStorage.setItem(STORAGE_KEY, setting)
  } catch {
    // 本次会话仍然应用该偏好。
  }
}

/** 在首次绘制前应用存储的主题（从 main.tsx 调用）。 */
export function initTheme(): ThemeSetting {
  const setting = storedTheme()
  const root = document.documentElement
  root.dataset.theme = resolvedTheme(setting)
  root.dataset.themeSetting = setting
  return setting
}

/** 当设置为 `system` 时订阅系统主题变化。返回一个
 *  取消订阅函数。 */
export function watchSystemTheme(onChange: () => void): () => void {
  const media = window.matchMedia(DARK_QUERY)
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}
