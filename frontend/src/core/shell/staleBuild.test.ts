// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import { entryOf } from './staleBuild'

describe('entryOf', () => {
  it('从 index.html 取带 hash 的入口脚本', () => {
    expect(entryOf('<script type="module" crossorigin src="/assets/index-Ab12.js"></script>')).toBe('/assets/index-Ab12.js')
  })
  it('开发服务器的入口不算', () => {
    expect(entryOf('<script type="module" src="/src/main.tsx"></script>')).toBeNull()
  })
})
