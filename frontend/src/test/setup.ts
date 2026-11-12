// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 组件测试的公共准备（只在 jsdom 的 project 里加载）
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// jsdom 没有 matchMedia，theme.ts 加载时就要用；默认按浅色系统、不触发变化
if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })
}

afterEach(() => {
  cleanup()
})
