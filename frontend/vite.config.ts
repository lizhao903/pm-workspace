// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 正式前端。dev server 固定 127.0.0.1:7780，避开真实服务、原型和测试实例的端口。
// /api 默认代理到测试实例（真实库的副本）；要连别的实例用 PMW_API 覆盖。
const api = process.env.PMW_API ?? 'http://127.0.0.1:7796'

// 外部插件（P1-a）共享的 React 入口：index.html 的 import map 指到固定产出的 /pmw-external-react.js。
// 和主应用在同一个构建里，React 模块只求值一次，插件和宿主共用一份实例。
const externalReact = fileURLToPath(new URL('./src/externalReact.ts', import.meta.url))
const indexHtml = fileURLToPath(new URL('./index.html', import.meta.url))

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      // 入口的导出必须保留：pmw-external-react.js 是给 import map 用的 ESM 入口，
      // 没了导出插件 import 不到 React。Vite 8/rolldown 默认会摇掉未被内部引用的入口导出。
      preserveEntrySignatures: 'strict',
      input: {
        index: indexHtml,
        'pmw-external-react': externalReact,
      },
      output: {
        // 只有共享 React 入口用固定文件名，其余入口和 chunk 照旧带 hash
        entryFileNames: (chunk) =>
          chunk.name === 'pmw-external-react' ? 'pmw-external-react.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 7780,
    strictPort: true,
    // ws：终端插件的收发是 WebSocket（TERM-01b）
    proxy: { '/api': { target: api, changeOrigin: true, ws: true } },
  },
})
