import { defineConfig } from 'vitest/config'

import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@x-code-cli/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      include: ['packages/*/src/**/*.{ts,tsx}'],
      exclude: ['**/*.d.ts', '**/manual-assets/**', '**/dist/**'],
      // 基线略低于当前全量测量值（lines 48.3 / stmts 46.7 / funcs 45.9 / branches 41.8），
      // 防止覆盖率静默下滑；新增代码应配套测试。
      thresholds: { statements: 45, branches: 40, functions: 44, lines: 46 },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/core/tests/**/*.test.ts', 'packages/cli/tests/*.test.{ts,tsx}'],
          sequence: { groupOrder: 0 },
          // 图片压缩和 PDF 解析会在并行负载下超过 5s 默认值；20s 仍能兜住真正的 hang。
          testTimeout: 20_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'desktop',
          include: ['packages/desktop/tests/**/*.test.ts'],
          sequence: { groupOrder: 1 },
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'faults',
          include: ['packages/cli/tests/faults/**/*.test.ts'],
          sequence: { groupOrder: 2 },
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'package',
          include: ['packages/cli/tests/package/**/*.test.ts'],
          sequence: { groupOrder: 3 },
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 240_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'pty',
          include: ['packages/cli/tests/pty/**/*.test.ts'],
          sequence: { groupOrder: 4 },
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
})
