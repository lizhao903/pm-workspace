import { defineConfig } from 'vitest/config'

// 最小 Vitest 配置（FE-02a 接入，QA-01 在此基础上补组件测试）。
// 默认只跑纯函数和打桩的测试；设了 PMW_LIVE_API 才跑连测试实例的那组。
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    provide: { liveApi: process.env.PMW_LIVE_API ?? '' },
  },
})
