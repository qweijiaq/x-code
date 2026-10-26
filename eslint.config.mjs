import reactHooks from 'eslint-plugin-react-hooks'
import unusedImports from 'eslint-plugin-unused-imports'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'

// 不使用 `recommendedTypeChecked` / `projectService: true` —— 类型感知的
// 检查会让保存时的自动修复变得不可靠（VS Code ESLint 扩展的 code-action
// 超时比冷启动 TS project service 更短）。唯一能从中受益的类型感知规则是
// `no-misused-promises`，但不值得为了它破坏保存时自动删除未使用 import 的能力。
export default defineConfig(
  {
    ignores: [
      // 仓库内的 skills 可能携带非项目运行时，并由独立流程校验。
      '.agents/skills/**',
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.js',
      '**/*.mjs',
      '**/tests/**',
      '**/vitest.config.ts',
    ],
  },
  tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        // Vitest 全局变量
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        vi: 'readonly',
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'unused-imports': unusedImports,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      // `unused-imports/no-unused-imports` 是生态中唯一能在保存时
      // 自动修复未使用代码的规则。它只覆盖 import —— 未使用的变量声明
      // 没有自动修复路径，会报告给用户手动删除（Ctrl+. → "Remove unused declaration"）
      // 或用 `_` 前缀静默。
      'unused-imports/no-unused-imports': 'error',
    },
  },
)
