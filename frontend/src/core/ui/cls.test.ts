import { describe, expect, it } from 'vitest'
import { cls } from './cls'

// 纯函数测试的样板：放在被测文件旁边，跑在 node 环境
describe('cls', () => {
  it('按顺序用空格拼接', () => {
    expect(cls('a', 'b', 'c')).toBe('a b c')
  })

  it('忽略 false、null、undefined 和空串', () => {
    expect(cls('a', false, null, undefined, '', 'b')).toBe('a b')
  })

  it('全是假值时返回空串', () => {
    expect(cls(false, undefined)).toBe('')
  })
})
