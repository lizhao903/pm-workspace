import { defineConfig } from 'vitest/config'

// Vitest 配置：FE-02a 接入最小版本，QA-01 补组件测试。
// 两个 project：*.test.ts 是纯函数和打桩的测试，跑在 node；*.test.tsx 是组件测试，跑在 jsdom。
// 默认不跑连测试实例的那组；设了 PMW_LIVE_API 才跑。
export default defineConfig({
  test: {
    provide: { liveApi: process.env.PMW_LIVE_API ?? '' },
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['src/**/*.test.ts'], environment: 'node' },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          include: ['src/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['src/test/setup.ts'],
        },
      },
    ],
  },
})
