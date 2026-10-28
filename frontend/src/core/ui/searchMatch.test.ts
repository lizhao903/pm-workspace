import { describe, expect, it } from 'vitest'
import { matchOption } from './searchMatch'

describe('matchOption', () => {
  const o = { label: '张三', keywords: 'zhangsan zs', hint: 'Acme 公司' }
  it('空查询全部命中', () => {
    expect(matchOption(o, '')).toBe(true)
    expect(matchOption(o, '   ')).toBe(true)
  })
  it('label、keywords、hint 任一命中，不区分大小写', () => {
    expect(matchOption(o, '张')).toBe(true)
    expect(matchOption(o, 'ZHANG')).toBe(true)
    expect(matchOption(o, 'acme')).toBe(true)
  })
  it('多个词都要命中', () => {
    expect(matchOption(o, 'zs acme')).toBe(true)
    expect(matchOption(o, 'zs 李四')).toBe(false)
  })
})
