// Progressive enhancement only: the page is complete without this file.

const root = document.documentElement
const THEME_KEY = 'xcode-theme'

function syncThemeChrome(theme) {
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#101110' : '#faf9f7')
  const toggle = document.getElementById('themeToggle')
  if (toggle) toggle.setAttribute('aria-pressed', String(theme === 'dark'))
}

const toggle = document.getElementById('themeToggle')
if (toggle) {
  syncThemeChrome(root.dataset.theme === 'dark' ? 'dark' : 'light')
  toggle.addEventListener('click', () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark'
    root.dataset.theme = next
    try {
      localStorage.setItem(THEME_KEY, next)
    } catch {
      // Private mode: the theme still applies for this visit.
    }
    syncThemeChrome(next)
  })
}

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const field = document.createElement('textarea')
    field.value = text
    field.setAttribute('readonly', '')
    field.style.position = 'fixed'
    field.style.opacity = '0'
    document.body.appendChild(field)
    field.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    document.body.removeChild(field)
    return ok
  }
}

for (const button of document.querySelectorAll('[data-copy]')) {
  const hint = button.querySelector('.copy-hint')
  const original = hint ? hint.textContent : ''
  button.addEventListener('click', async () => {
    const ok = await writeClipboard(button.dataset.copy || '')
    if (!hint) return
    hint.textContent = ok ? 'Copied' : 'Press ⌘C'
    button.classList.toggle('is-copied', ok)
    window.setTimeout(() => {
      hint.textContent = original
      button.classList.remove('is-copied')
    }, 1600)
  })
}
