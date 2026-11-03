import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 新版前端样式原型。只用 src/data.ts 里的演示数据，故意不配 /api 代理——
// 7777 上跑的是真实数据库，原型阶段不该有任何路径能写到它。
export default defineConfig({
  plugins: [react()],
  server: { port: 7778, strictPort: true, host: '127.0.0.1' },
})
