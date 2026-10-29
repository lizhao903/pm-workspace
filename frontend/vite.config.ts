import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 正式前端。dev server 固定 127.0.0.1:7780，避开真实服务、原型和测试实例的端口。
// /api 默认代理到测试实例（真实库的副本）；要连别的实例用 PMW_API 覆盖。
const api = process.env.PMW_API ?? 'http://127.0.0.1:7796'

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 7780,
    strictPort: true,
    // ws：终端插件的收发是 WebSocket（TERM-01b）
    proxy: { '/api': { target: api, changeOrigin: true, ws: true } },
  },
})
