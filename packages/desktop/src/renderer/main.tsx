import React from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App.js'
import './i18n.js'
import './styles.css'
import { initTheme } from './theme.js'

initTheme()

const container = document.getElementById('root')
if (!container) throw new Error('Missing #root')

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
