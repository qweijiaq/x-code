import { defineConfig } from 'vitest/config'

import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@x-code-cli/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
  },
})
