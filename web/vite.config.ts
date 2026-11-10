// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 前端构建产物直接落进 internal/webui/dist，由 Go 二进制 embed。
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../internal/webui/dist',
    emptyOutDir: true,
  },
  server: {
    port: Number(process.env.PMW_DEV_PORT ?? 5173),
    // dev server 的 /api 默认代理到本机工作台。注意这是**真实数据库**——
    // 在 dev 界面上做的任何写操作（改状态、批量删除）都会直接落到它上面。
    // 要对着一次性实例开发或做自动化测试，务必先起临时实例再覆盖这个地址：
    //   go build -o /tmp/pmw-t ./cmd/pmw
    //   /tmp/pmw-t --db /tmp/t.db --addr 127.0.0.1:7921 --seed-demo &
    //   PMW_API=http://127.0.0.1:7921 npm run dev
    proxy: { '/api': process.env.PMW_API ?? 'http://127.0.0.1:7777' },
  },
})
