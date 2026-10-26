import esbuild from 'esbuild'

import { builtinModules } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const outdir = path.join(dir, 'dist')

const external = [
  'electron',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  // 原生扩展和按安装路径解析资源的包。
  'node-pty',
  'fs-ext-extra-prebuilt',
  '@napi-rs/canvas',
  '@vscode/ripgrep',
  'tesseract.js',
  'pdf-parse',
  'undici',
  '@fugood/whisper.node',
  '@fugood/node-whisper-darwin-arm64',
  '@fugood/node-whisper-darwin-x64',
  '@fugood/node-whisper-win32-x64',
  '@fugood/node-whisper-win32-arm64',
  '@fugood/node-whisper-linux-x64',
  '@fugood/node-whisper-linux-arm64',
  '@fugood/node-whisper-linux-x64-vulkan',
  '@fugood/node-whisper-linux-x64-cuda',
  '@fugood/node-whisper-wasm',
  '@napi-audio/decoder',
]

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  external,
  sourcemap: process.env.X_CODE_SOURCEMAP === '1',
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': '"production"',
  },
}

await esbuild.build({
  ...common,
  entryPoints: [path.join(dir, 'src/main/index.ts')],
  outfile: path.join(outdir, 'main/index.cjs'),
  format: 'cjs',
})

await esbuild.build({
  ...common,
  entryPoints: [path.join(dir, 'src/preload/index.ts')],
  outfile: path.join(outdir, 'preload/index.cjs'),
  format: 'cjs',
})

await esbuild.build({
  ...common,
  entryPoints: [path.join(dir, 'src/runtime/index.ts')],
  outfile: path.join(outdir, 'runtime/index.mjs'),
  format: 'esm',
  banner: {
    // 打包进来的 CJS 依赖可能在运行时调用 require()。
    // 在 esbuild 的互操作辅助代码运行前提供 Node 的 ESM 等价实现。
    js: `
import { fileURLToPath as ___fileURLToPath } from 'node:url';
import { dirname as ___dirname_fn } from 'node:path';
import { createRequire as ___createRequire } from 'node:module';
var __filename = ___fileURLToPath(import.meta.url);
var __dirname = ___dirname_fn(__filename);
var require = ___createRequire(import.meta.url);
`,
  },
})

// Core 会相对打包后的 runtime 模块（`./<name>.js`）解析这些 worker，
// 因此要把它们输出到 dist/runtime/index.mjs 旁边。
const coreSrc = path.resolve(dir, '../core/src')
await esbuild.build({
  ...common,
  entryPoints: {
    'office-xlsx-worker': path.join(coreSrc, 'agent/office-xlsx-worker.ts'),
    'audio-transcribe-worker': path.join(coreSrc, 'agent/audio-transcribe-worker.ts'),
    'pdf-render-worker': path.join(coreSrc, 'agent/pdf-render-worker.ts'),
    'image-compress-worker': path.join(coreSrc, 'utils/image-compress-worker.ts'),
  },
  outdir: path.join(outdir, 'runtime'),
  format: 'esm',
  entryNames: '[name]',
  splitting: false,
})
