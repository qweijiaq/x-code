import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: path.join(dir, 'src/renderer'),
  base: './',
  plugins: [react()],
  build: {
    outDir: path.join(dir, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome130',
  },
})
