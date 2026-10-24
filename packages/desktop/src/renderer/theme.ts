// Theme preference: light, dark, or follow the OS. The resolved value is
// written to <html data-theme>, which the ink-wash CSS variables key off.
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
    // Preference is still applied for this session.
  }
}

/** Apply the stored theme before the first paint (call from main.tsx). */
export function initTheme(): ThemeSetting {
  const setting = storedTheme()
  const root = document.documentElement
  root.dataset.theme = resolvedTheme(setting)
  root.dataset.themeSetting = setting
  return setting
}

/** Subscribe to OS theme changes while the setting is `system`. Returns an
 *  unsubscribe function. */
export function watchSystemTheme(onChange: () => void): () => void {
  const media = window.matchMedia(DARK_QUERY)
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}
